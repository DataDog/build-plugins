// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { cleanEnv } from '@dd/tests/_jest/helpers/env';
import { getContextMock, getRepositoryDataMock } from '@dd/tests/_jest/helpers/mocks';
import fs from 'fs/promises';
import JSZip from 'jszip';
import os from 'os';
import path from 'path';

import * as assets from './assets';
import type { BackendFunction } from './backend/types';
import { ARCHIVE_FILENAME } from './constants';
import * as identifier from './identifier';
import type { AppsOptionsWithDefaults } from './types';
import {
    buildAppPackage,
    BUILD_ARTIFACT_FILENAME,
    BUILD_ARTIFACT_SCHEMA_VERSION,
} from './vite/build-package';

describe('Apps Plugin - package output', () => {
    let root: string;
    let packageDirectory: string;
    let sourcePath: string;
    let restoreEnv: () => void;

    beforeEach(async () => {
        restoreEnv = cleanEnv();
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'dd-apps-package-'));
        packageDirectory = path.join(root, 'dist');
        sourcePath = path.join(root, 'index.html');
        await fs.mkdir(packageDirectory, { recursive: true });
        await fs.writeFile(sourcePath, '<main>app</main>');
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'app-id',
            name: 'Example App',
        });
        jest.spyOn(assets, 'collectAssets').mockResolvedValue([
            { absolutePath: sourcePath, relativePath: 'index.html' },
        ]);
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        restoreEnv();
        await fs.rm(root, { recursive: true, force: true });
    });

    function packageOptions(
        overrides: {
            options?: Partial<AppsOptionsWithDefaults>;
            backendOutputs?: Map<string, string>;
            backendFunctions?: BackendFunction[];
        } = {},
    ) {
        return {
            backendOutputs: overrides.backendOutputs ?? new Map<string, string>(),
            backendFunctions: overrides.backendFunctions ?? [],
            context: getContextMock({
                buildRoot: root,
                bundler: { name: 'vite', version: 'test', outDir: packageDirectory },
                git: getRepositoryDataMock({ remote: 'git@github.com:org/repo.git' }),
            }),
            options: {
                include: [],
                authOverrides: { method: 'oauth' as const },
                ...overrides.options,
            },
        };
    }

    test('writes a deployable archive and versioned artifact sidecar', async () => {
        const artifact = await buildAppPackage(packageOptions());

        expect(artifact).toEqual({
            schemaVersion: BUILD_ARTIFACT_SCHEMA_VERSION,
            bundle: ARCHIVE_FILENAME,
            identifier: 'app-id',
            name: 'Example App',
        });
        await expect(
            fs.readFile(path.join(packageDirectory, BUILD_ARTIFACT_FILENAME), 'utf8'),
        ).resolves.toContain('"schemaVersion": 1');
        const zip = await JSZip.loadAsync(
            await fs.readFile(path.join(packageDirectory, ARCHIVE_FILENAME)),
        );
        expect(Object.keys(zip.files)).toEqual(
            expect.arrayContaining(['frontend/index.html', 'manifest.json']),
        );
    });

    test('does not nest stale generated package files into the archive', async () => {
        const staleArchive = path.join(packageDirectory, ARCHIVE_FILENAME);
        const staleDescriptor = path.join(packageDirectory, BUILD_ARTIFACT_FILENAME);
        await Promise.all([
            fs.writeFile(staleArchive, 'stale archive'),
            fs.writeFile(staleDescriptor, 'stale descriptor'),
        ]);
        jest.spyOn(assets, 'collectAssets').mockResolvedValue([
            { absolutePath: sourcePath, relativePath: 'index.html' },
            { absolutePath: staleArchive, relativePath: ARCHIVE_FILENAME },
            { absolutePath: staleDescriptor, relativePath: BUILD_ARTIFACT_FILENAME },
        ]);

        await buildAppPackage(packageOptions());

        const zip = await JSZip.loadAsync(await fs.readFile(staleArchive));
        expect(Object.keys(zip.files)).not.toEqual(
            expect.arrayContaining([
                `frontend/${ARCHIVE_FILENAME}`,
                `frontend/${BUILD_ARTIFACT_FILENAME}`,
            ]),
        );
    });

    test('includes description, selfService, and permissions in manifest.json when configured', async () => {
        await buildAppPackage(
            packageOptions({
                options: {
                    description: 'My app description',
                    selfService: true,
                    permissions: { protectionLevel: 'approval_required' },
                },
            }),
        );

        const zip = await JSZip.loadAsync(
            await fs.readFile(path.join(packageDirectory, ARCHIVE_FILENAME)),
        );
        const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
        expect(manifest).toEqual({
            description: 'My app description',
            selfService: true,
            permissions: { protectionLevel: 'approval_required' },
            backend: { functions: {} },
        });
    });

    test('includes selfService: false in manifest.json when explicitly set to false', async () => {
        await buildAppPackage(
            packageOptions({
                options: { selfService: false },
            }),
        );

        const zip = await JSZip.loadAsync(
            await fs.readFile(path.join(packageDirectory, ARCHIVE_FILENAME)),
        );
        const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
        expect(manifest).toHaveProperty('selfService', false);
    });

    test('omits description, selfService, and permissions from manifest.json when not configured', async () => {
        await buildAppPackage(packageOptions());

        const zip = await JSZip.loadAsync(
            await fs.readFile(path.join(packageDirectory, ARCHIVE_FILENAME)),
        );
        const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
        expect(manifest).toEqual({ backend: { functions: {} } });
        expect(manifest).not.toHaveProperty('description');
        expect(manifest).not.toHaveProperty('selfService');
        expect(manifest).not.toHaveProperty('permissions');
    });

    test('includes runAs in manifest.json when configured', async () => {
        await buildAppPackage(
            packageOptions({
                options: {
                    permissions: {
                        protectionLevel: 'direct_publish',
                        runAs: '550e8400-e29b-41d4-a716-446655440000',
                    },
                },
            }),
        );

        const zip = await JSZip.loadAsync(
            await fs.readFile(path.join(packageDirectory, ARCHIVE_FILENAME)),
        );
        const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
        expect(manifest).toEqual({
            permissions: {
                protectionLevel: 'direct_publish',
                runAs: '550e8400-e29b-41d4-a716-446655440000',
            },
            backend: { functions: {} },
        });
    });

    test('omits permissions from manifest.json when permissions is an empty object', async () => {
        await buildAppPackage(
            packageOptions({
                options: { permissions: {} },
            }),
        );

        const zip = await JSZip.loadAsync(
            await fs.readFile(path.join(packageDirectory, ARCHIVE_FILENAME)),
        );
        const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
        expect(manifest).toEqual({ backend: { functions: {} } });
        expect(manifest).not.toHaveProperty('permissions');
    });

    test('omits null subfields from permissions in manifest.json', async () => {
        await buildAppPackage(
            packageOptions({
                options: {
                    permissions: {
                        protectionLevel: null as unknown as 'direct_publish',
                        runAs: '550e8400-e29b-41d4-a716-446655440000',
                    },
                },
            }),
        );

        const zip = await JSZip.loadAsync(
            await fs.readFile(path.join(packageDirectory, ARCHIVE_FILENAME)),
        );
        const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
        expect(manifest).toEqual({
            permissions: { runAs: '550e8400-e29b-41d4-a716-446655440000' },
            backend: { functions: {} },
        });
        expect(manifest.permissions).not.toHaveProperty('protectionLevel');
    });

    test('includes backend function entries with connection allowlists in manifest.json', async () => {
        const backendPath = path.join(root, 'greet.js');
        await fs.writeFile(backendPath, 'export function greet() {}');
        const backendFunction: BackendFunction = {
            relativePath: 'src/backend/greet',
            name: 'greet',
            absolutePath: backendPath,
            allowedConnectionIds: ['conn-a', 'conn-b'],
        };
        const backendOutputs = new Map<string, string>([['greet', backendPath]]);

        await buildAppPackage(
            packageOptions({
                backendOutputs,
                backendFunctions: [backendFunction],
            }),
        );

        const zip = await JSZip.loadAsync(
            await fs.readFile(path.join(packageDirectory, ARCHIVE_FILENAME)),
        );
        const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
        const functionKeys = Object.keys(manifest.backend.functions);
        expect(functionKeys).toHaveLength(1);
        expect(functionKeys[0]).toMatch(/^[a-f0-9]{64}\.greet$/);
        expect(manifest.backend.functions[functionKeys[0]]).toEqual({
            allowedConnectionIds: ['conn-a', 'conn-b'],
        });
        expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(['backend/greet.js']));
    });
});
