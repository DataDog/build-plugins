// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as archive from '@dd/apps-plugin/archive';
import * as assets from '@dd/apps-plugin/assets';
import { getPlugins } from '@dd/apps-plugin';
import type { PluginOptions } from '@dd/core/types';
import * as fsHelpers from '@dd/core/helpers/fs';
import { cleanEnv } from '@dd/tests/_jest/helpers/env';
import {
    getContextMock,
    getGetPluginsArg,
    getMockBundler,
    getRepositoryDataMock,
} from '@dd/tests/_jest/helpers/mocks';
import { mkdtempSync } from 'fs';
import fsp from 'fs/promises';
import fs from 'fs/promises';
import JSZip from 'jszip';
import os from 'os';
import path from 'path';
import { parseAst } from 'rollup/parseAst';

import type { BackendFunction } from './backend/types';
import { ARCHIVE_FILENAME } from './constants';
import type { AppsOptionsWithDefaults } from './types';
import { buildAppPackage } from './vite/build-package';

/** Extract and assert closeBundle from the first plugin's vite hooks. */
function extractCloseBundle(plugins: PluginOptions[]) {
    const plugin = plugins[0];
    expect(typeof plugin?.vite?.closeBundle).toBe('function');
    return plugin.vite!.closeBundle as () => Promise<void>;
}

/** Extract and assert the Vite transform hook from the first plugin's vite hooks. */
function extractViteTransform(plugins: PluginOptions[]) {
    const transform = plugins[0].vite?.transform;
    expect(transform).toEqual(expect.objectContaining({ handler: expect.any(Function) }));
    return (transform as { handler: (code: string, id: string) => Promise<unknown> }).handler;
}

function emitModuleParsed(
    config: {
        plugins?: Array<{
            moduleParsed?: (this: { parse: typeof parseAst }, moduleInfo: unknown) => void;
        }>;
    },
    id: string,
    code: string,
    importedIds: string[] = [],
) {
    for (const plugin of config.plugins ?? []) {
        plugin.moduleParsed?.call(
            { parse: parseAst },
            {
                id,
                code,
                importedIds,
            },
        );
    }
}

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
                ...overrides.options,
            },
        };
    }

    test('writes a deployable archive', async () => {
        const archivePath = await buildAppPackage(packageOptions());

        expect(archivePath).toBe(path.join(packageDirectory, ARCHIVE_FILENAME));
        const zip = await JSZip.loadAsync(
            await fs.readFile(path.join(packageDirectory, ARCHIVE_FILENAME)),
        );
        expect(Object.keys(zip.files)).toEqual(
            expect.arrayContaining(['frontend/index.html', 'manifest.json']),
        );
    });

    test('does not nest stale generated package files into the archive', async () => {
        const staleArchive = path.join(packageDirectory, ARCHIVE_FILENAME);
        await fs.writeFile(staleArchive, 'stale archive');
        jest.spyOn(assets, 'collectAssets').mockResolvedValue([
            { absolutePath: sourcePath, relativePath: 'index.html' },
            { absolutePath: staleArchive, relativePath: ARCHIVE_FILENAME },
        ]);

        await buildAppPackage(packageOptions());

        const zip = await JSZip.loadAsync(await fs.readFile(staleArchive));
        expect(Object.keys(zip.files)).not.toEqual(
            expect.arrayContaining([`frontend/${ARCHIVE_FILENAME}`]),
        );
    });

    test('writes manifest.json with only backend function entries', async () => {
        await buildAppPackage(packageOptions());

        const zip = await JSZip.loadAsync(
            await fs.readFile(path.join(packageDirectory, ARCHIVE_FILENAME)),
        );
        const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
        expect(manifest).toEqual({ backend: { functions: {} } });
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

describe('Apps Plugin - getPlugins closeBundle', () => {
    // The module-graph collector needs buildRoot to match the virtual module ids
    // used below; buildAppPackage needs a real outDir it can write into.
    const buildRoot = '/project';
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'dd-apps-closebundle-'));
    const getArgs = () =>
        getGetPluginsArg(
            { apps: {} },
            {
                bundler: { ...getMockBundler({ name: 'vite' }), outDir },
                buildRoot,
                git: getRepositoryDataMock({ remote: 'git@github.com:org/repo.git' }),
            },
        );

    afterEach(async () => {
        jest.restoreAllMocks();
        await fs.rm(outDir, { recursive: true, force: true });
    });

    test('Should include reachable helper module connection allowlists in manifest.json', async () => {
        jest.spyOn(assets, 'collectAssets').mockResolvedValue([
            { absolutePath: '/project/dist/index.js', relativePath: 'dist/index.js' },
        ]);
        jest.spyOn(fsHelpers, 'rm').mockResolvedValue(undefined);

        let manifest: unknown;
        jest.spyOn(archive, 'createArchive').mockImplementation(async (archiveAssets) => {
            const manifestAsset = archiveAssets.find(
                (asset) => asset.relativePath === 'manifest.json',
            );
            expect(manifestAsset).toBeDefined();
            manifest = JSON.parse(await fsp.readFile(manifestAsset!.absolutePath, 'utf8'));
            return {
                archivePath: '/tmp/dd-apps-790/datadog-app-assets.zip',
                assets: archiveAssets,
                size: 30,
            };
        });

        const entryCode = `
            import { getEcho } from './helpers/http.js';

            export function greet() {
                return getEcho();
            }
        `;
        const helperCode = `
            import { request } from '@datadog/action-catalog/http/http';

            const HTTP_CONNECTION_ID = 'conn-helper';

            export function getEcho() {
                return request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
            }
        `;
        const helperId = '/project/src/backend/helpers/http.js';
        const viteBuild = jest.fn().mockImplementation(async (config) => {
            emitModuleParsed(config, '/project/src/backend/greet.backend.js', entryCode, [
                helperId,
            ]);
            emitModuleParsed(config, helperId, helperCode);
            return {
                output: [
                    {
                        type: 'chunk',
                        isEntry: true,
                        name: expect.any(String),
                        fileName: 'unused.greet.js',
                    },
                ],
            };
        });
        const args = getArgs();
        args.bundler = { build: viteBuild };
        const plugins = getPlugins(args);
        const transform = extractViteTransform(plugins);
        await transform.call(
            {
                parse: parseAst,
                resolve: jest.fn(async (specifier: string) =>
                    specifier === './helpers/http.js' ? { id: helperId } : null,
                ),
                load: jest.fn(async () => null),
                addWatchFile: jest.fn(),
            },
            entryCode,
            '/project/src/backend/greet.backend.js',
        );

        await extractCloseBundle(plugins)();

        expect(
            Object.values(
                (manifest as { backend: { functions: Record<string, unknown> } }).backend.functions,
            ),
        ).toEqual([{ allowedConnectionIds: ['conn-helper'] }]);
    });

    test('Should reject a Node builtin import inside a helper module reachable from a backend function', async () => {
        jest.spyOn(assets, 'collectAssets').mockResolvedValue([
            { absolutePath: '/project/dist/index.js', relativePath: 'dist/index.js' },
        ]);
        jest.spyOn(fsHelpers, 'rm').mockResolvedValue(undefined);

        // The entry file alone is clean; only importing a local helper is visible from here.
        const entryCode = `
            import { readSecret } from './helpers/fs-helper.js';

            export function greet() {
                return readSecret();
            }
        `;
        // Only the nested backend build's module graph walk sees this Node builtin import; the outer transform never reaches the helper.
        const helperCode = `
            import fs from 'fs';

            export function readSecret() {
                return fs.readFileSync('/etc/passwd', 'utf8');
            }
        `;
        const helperId = '/project/src/backend/helpers/fs-helper.js';
        const viteBuild = jest.fn().mockImplementation(async (config) => {
            emitModuleParsed(config, '/project/src/backend/greet.backend.js', entryCode, [
                helperId,
            ]);
            emitModuleParsed(config, helperId, helperCode);
            return {
                output: [
                    {
                        type: 'chunk',
                        isEntry: true,
                        name: expect.any(String),
                        fileName: 'unused.greet.js',
                    },
                ],
            };
        });
        const args = getArgs();
        args.bundler = { build: viteBuild };
        const plugins = getPlugins(args);
        const transform = extractViteTransform(plugins);
        const resolveMock = jest.fn(async (specifier: string) =>
            specifier === './helpers/fs-helper.js' ? { id: helperId } : null,
        );
        const loadMock = jest.fn(async () => null);
        const addWatchFileMock = jest.fn();
        await transform.call(
            {
                parse: parseAst,
                resolve: resolveMock,
                load: loadMock,
                addWatchFile: addWatchFileMock,
            },
            entryCode,
            '/project/src/backend/greet.backend.js',
        );

        const closeBundleResult = extractCloseBundle(plugins)();
        await expect(closeBundleResult).rejects.toThrow(
            'Importing Node built-in module "fs" is not supported in backend function code',
        );
    });

    test('Should reject a bare fetch() call inside a helper module reachable from a backend function', async () => {
        jest.spyOn(assets, 'collectAssets').mockResolvedValue([
            { absolutePath: '/project/dist/index.js', relativePath: 'dist/index.js' },
        ]);
        jest.spyOn(fsHelpers, 'rm').mockResolvedValue(undefined);

        const entryCode = `
            import { getEcho } from './helpers/http-helper.js';

            export function greet() {
                return getEcho();
            }
        `;
        const helperCode = `
            export function getEcho() {
                return fetch('https://example.com');
            }
        `;
        const helperId = '/project/src/backend/helpers/http-helper.js';
        const viteBuild = jest.fn().mockImplementation(async (config) => {
            emitModuleParsed(config, '/project/src/backend/greet.backend.js', entryCode, [
                helperId,
            ]);
            emitModuleParsed(config, helperId, helperCode);
            return {
                output: [
                    {
                        type: 'chunk',
                        isEntry: true,
                        name: expect.any(String),
                        fileName: 'unused.greet.js',
                    },
                ],
            };
        });
        const args = getArgs();
        args.bundler = { build: viteBuild };
        const plugins = getPlugins(args);
        const transform = extractViteTransform(plugins);
        const resolveMock = jest.fn(async (specifier: string) =>
            specifier === './helpers/http-helper.js' ? { id: helperId } : null,
        );
        const loadMock = jest.fn(async () => null);
        const addWatchFileMock = jest.fn();
        await transform.call(
            {
                parse: parseAst,
                resolve: resolveMock,
                load: loadMock,
                addWatchFile: addWatchFileMock,
            },
            entryCode,
            '/project/src/backend/greet.backend.js',
        );

        const closeBundleResult = extractCloseBundle(plugins)();
        await expect(closeBundleResult).rejects.toThrow(
            'Using "fetch" is not supported in backend function code',
        );
    });
});
