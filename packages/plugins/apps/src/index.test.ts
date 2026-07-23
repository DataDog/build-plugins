// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as archive from '@dd/apps-plugin/archive';
import * as assets from '@dd/apps-plugin/assets';
import * as identifier from '@dd/apps-plugin/identifier';
import * as uploader from '@dd/apps-plugin/upload';
import { getPlugins } from '@dd/apps-plugin';
import { DEFAULT_SITE } from '@dd/core/constants';
import * as fsHelpers from '@dd/core/helpers/fs';
import { InjectPosition } from '@dd/core/types';
import type { PluginOptions } from '@dd/core/types';
import {
    getGetPluginsArg,
    getMockBundler,
    getRepositoryDataMock,
    mockLogFn,
} from '@dd/tests/_jest/helpers/mocks';
import { runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import fsp from 'fs/promises';
import nock from 'nock';
import path from 'path';
import { parseAst } from 'rollup/parseAst';

import { APPS_API_PATH } from './constants';
import { handleUpload } from './vite/handle-upload';

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
    config: { plugins?: Array<{ moduleParsed?: (moduleInfo: unknown) => void }> },
    id: string,
    code: string,
    importedIds: string[] = [],
) {
    for (const plugin of config.plugins ?? []) {
        plugin.moduleParsed?.({
            id,
            ast: parseAst(code),
            importedIds,
        });
    }
}

describe('Apps Plugin - getPlugins', () => {
    const buildRoot = '/project';
    const outDir = '/project/dist';
    const getArgs = () =>
        getGetPluginsArg(
            { apps: {} },
            {
                bundler: { ...getMockBundler({ name: 'vite' }), outDir },
                buildRoot,
                git: getRepositoryDataMock({ remote: 'git@github.com:org/repo.git' }),
            },
        );

    beforeEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(() => {
        nock.cleanAll();
    });

    test('Should not initialize when disabled', () => {
        expect(getPlugins(getGetPluginsArg())).toHaveLength(0);
        expect(getPlugins(getGetPluginsArg({ apps: { enable: false } }))).toHaveLength(0);
    });

    test('Should initialize when enabled', () => {
        expect(getPlugins(getArgs())).toHaveLength(1);
    });

    test('Should inject the apps runtime at the top of the user bundle when enabled', () => {
        const injectMock = jest.fn();
        getPlugins(
            getGetPluginsArg(
                { apps: {} },
                { bundler: { ...getMockBundler({ name: 'vite' }), outDir }, inject: injectMock },
            ),
        );

        expect(injectMock).toHaveBeenCalledWith({
            type: 'file',
            position: InjectPosition.MIDDLE,
            value: expect.stringContaining('apps-runtime.mjs'),
        });
    });

    test('Should not inject the runtime when disabled', () => {
        const injectMock = jest.fn();
        getPlugins(getGetPluginsArg({ apps: { enable: false } }, { inject: injectMock }));

        expect(injectMock).not.toHaveBeenCalled();
    });

    test('Should log an error when identifier cannot be resolved', async () => {
        const collectSpy = jest.spyOn(assets, 'collectAssets').mockResolvedValue([]);
        const uploadSpy = jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({
            errors: [],
            warnings: [],
        });
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({});

        const closeBundle = extractCloseBundle(getPlugins(getArgs()));
        await expect(closeBundle()).rejects.toThrow('Missing apps identification');

        expect(uploadSpy).not.toHaveBeenCalled();
        expect(collectSpy).not.toHaveBeenCalled();
        expect(mockLogFn).toHaveBeenCalledWith(
            expect.stringContaining('Missing apps identification'),
            'error',
        );
    });

    test('Should skip upload when no assets are found', async () => {
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
        jest.spyOn(assets, 'collectAssets').mockResolvedValue([]);
        jest.spyOn(archive, 'createArchive').mockResolvedValue({
            archivePath: '',
            assets: [],
            size: 0,
        });
        jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({
            errors: [],
            warnings: [],
        });
        const rmSpy = jest.spyOn(fsHelpers, 'rm').mockResolvedValue(undefined);

        const closeBundle = extractCloseBundle(
            getPlugins(
                getGetPluginsArg(
                    { apps: { include: ['public/**/*'] } },
                    { bundler: { ...getMockBundler({ name: 'vite' }), outDir }, buildRoot },
                ),
            ),
        );

        await closeBundle();

        expect(assets.collectAssets).toHaveBeenCalledWith(['public/**/*', 'dist/**/*'], buildRoot);
        expect(archive.createArchive).not.toHaveBeenCalled();
        expect(uploader.uploadArchive).not.toHaveBeenCalled();
        expect(rmSpy).not.toHaveBeenCalled();
        expect(mockLogFn).toHaveBeenCalledWith(
            expect.stringContaining('No assets to upload'),
            'debug',
        );
    });

    test('Should upload archive, log warnings and cleanup temp directory', async () => {
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
        const mockedAssets = [
            { absolutePath: '/project/dist/index.js', relativePath: 'dist/index.js' },
        ];
        jest.spyOn(assets, 'collectAssets').mockResolvedValue(mockedAssets);
        jest.spyOn(fsHelpers, 'rm').mockResolvedValue(undefined);
        let manifest: unknown;
        jest.spyOn(archive, 'createArchive').mockImplementation(async (archiveAssets) => {
            const manifestAsset = archiveAssets.find(
                (asset) => asset.relativePath === 'manifest.json',
            );
            expect(manifestAsset).toBeDefined();
            manifest = JSON.parse(await fsp.readFile(manifestAsset!.absolutePath, 'utf8'));
            return {
                archivePath: '/tmp/dd-apps-123/datadog-apps-assets.zip',
                assets: archiveAssets,
                size: 10,
            };
        });
        jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({
            errors: [],
            warnings: ['first warning'],
        });

        const closeBundle = extractCloseBundle(getPlugins(getArgs()));
        await closeBundle();

        expect(assets.collectAssets).toHaveBeenCalledWith(['dist/**/*'], buildRoot);
        expect(archive.createArchive).toHaveBeenCalledWith(
            expect.arrayContaining([
                {
                    absolutePath: '/project/dist/index.js',
                    relativePath: path.join('frontend', 'dist/index.js'),
                },
                expect.objectContaining({
                    relativePath: 'manifest.json',
                }),
            ]),
        );
        expect(manifest).toEqual({ backend: { functions: {} } });
        expect(uploader.uploadArchive).toHaveBeenCalledWith(
            expect.objectContaining({ archivePath: '/tmp/dd-apps-123/datadog-apps-assets.zip' }),
            {
                bundlerName: 'vite',
                doAuthenticatedRequest: expect.any(Function),
                dryRun: true,
                identifier: 'repo:app',
                name: 'test-app',
                site: DEFAULT_SITE,
                version: 'FAKE_VERSION',
            },
            expect.anything(),
        );
        expect(mockLogFn).toHaveBeenCalledWith(
            expect.stringContaining('Warnings while uploading assets'),
            'warn',
        );
        expect(fsHelpers.rm).toHaveBeenCalledWith(path.resolve('/tmp/dd-apps-123'));
        expect(fsHelpers.rm).toHaveBeenCalledWith(expect.stringContaining('dd-apps-manifest-'));
    });

    test('Should include description, selfService, and permissions in manifest.json when configured', async () => {
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
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
                archivePath: '/tmp/dd-apps-123/datadog-apps-assets.zip',
                assets: archiveAssets,
                size: 10,
            };
        });
        jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({ errors: [], warnings: [] });

        const closeBundle = extractCloseBundle(
            getPlugins(
                getGetPluginsArg(
                    {
                        apps: {
                            description: 'My app description',
                            selfService: true,
                            permissions: {
                                protectionLevel: 'approval_required',
                            },
                        },
                    },
                    {
                        bundler: { ...getMockBundler({ name: 'vite' }), outDir },
                        buildRoot,
                        git: getRepositoryDataMock({ remote: 'git@github.com:org/repo.git' }),
                    },
                ),
            ),
        );
        await closeBundle();

        expect(manifest).toEqual({
            description: 'My app description',
            selfService: true,
            permissions: { protectionLevel: 'approval_required' },
            backend: { functions: {} },
        });
    });

    test('Should include selfService: false in manifest.json when explicitly set to false', async () => {
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
        jest.spyOn(assets, 'collectAssets').mockResolvedValue([
            { absolutePath: '/project/dist/index.js', relativePath: 'dist/index.js' },
        ]);
        jest.spyOn(fsHelpers, 'rm').mockResolvedValue(undefined);
        let manifest: unknown;
        jest.spyOn(archive, 'createArchive').mockImplementation(async (archiveAssets) => {
            const manifestAsset = archiveAssets.find(
                (asset) => asset.relativePath === 'manifest.json',
            );
            manifest = JSON.parse(await fsp.readFile(manifestAsset!.absolutePath, 'utf8'));
            return {
                archivePath: '/tmp/dd-apps-123/datadog-apps-assets.zip',
                assets: archiveAssets,
                size: 10,
            };
        });
        jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({ errors: [], warnings: [] });

        const closeBundle = extractCloseBundle(
            getPlugins(
                getGetPluginsArg(
                    { apps: { selfService: false } },
                    {
                        bundler: { ...getMockBundler({ name: 'vite' }), outDir },
                        buildRoot,
                        git: getRepositoryDataMock({ remote: 'git@github.com:org/repo.git' }),
                    },
                ),
            ),
        );
        await closeBundle();

        expect(manifest).toHaveProperty('selfService', false);
    });

    test('Should omit description, selfService, and permissions from manifest.json when not configured', async () => {
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
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
                archivePath: '/tmp/dd-apps-123/datadog-apps-assets.zip',
                assets: archiveAssets,
                size: 10,
            };
        });
        jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({ errors: [], warnings: [] });

        const closeBundle = extractCloseBundle(getPlugins(getArgs()));
        await closeBundle();

        // Backwards compat: manifest must not contain new fields when not configured
        expect(manifest).toEqual({ backend: { functions: {} } });
        expect(manifest).not.toHaveProperty('description');
        expect(manifest).not.toHaveProperty('selfService');
        expect(manifest).not.toHaveProperty('permissions');
    });

    test('Should include runAs in manifest.json when configured', async () => {
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
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
                archivePath: '/tmp/dd-apps-123/datadog-apps-assets.zip',
                assets: archiveAssets,
                size: 10,
            };
        });
        jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({ errors: [], warnings: [] });

        const closeBundle = extractCloseBundle(
            getPlugins(
                getGetPluginsArg(
                    {
                        apps: {
                            permissions: {
                                protectionLevel: 'direct_publish',
                                runAs: '550e8400-e29b-41d4-a716-446655440000',
                            },
                        },
                    },
                    {
                        bundler: { ...getMockBundler({ name: 'vite' }), outDir },
                        buildRoot,
                        git: getRepositoryDataMock({ remote: 'git@github.com:org/repo.git' }),
                    },
                ),
            ),
        );
        await closeBundle();

        expect(manifest).toEqual({
            permissions: {
                protectionLevel: 'direct_publish',
                runAs: '550e8400-e29b-41d4-a716-446655440000',
            },
            backend: { functions: {} },
        });
    });

    test('Should omit permissions from manifest.json when permissions is an empty object', async () => {
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
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
                archivePath: '/tmp/dd-apps-123/datadog-apps-assets.zip',
                assets: archiveAssets,
                size: 10,
            };
        });
        jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({ errors: [], warnings: [] });

        const closeBundle = extractCloseBundle(
            getPlugins(
                getGetPluginsArg(
                    {
                        apps: {
                            // Empty permissions object — must not appear in manifest
                            permissions: {},
                        },
                    },
                    {
                        bundler: { ...getMockBundler({ name: 'vite' }), outDir },
                        buildRoot,
                        git: getRepositoryDataMock({ remote: 'git@github.com:org/repo.git' }),
                    },
                ),
            ),
        );
        await closeBundle();

        expect(manifest).toEqual({ backend: { functions: {} } });
        expect(manifest).not.toHaveProperty('permissions');
    });

    test('Should omit null subfields from permissions in manifest.json', async () => {
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
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
                archivePath: '/tmp/dd-apps-123/datadog-apps-assets.zip',
                assets: archiveAssets,
                size: 10,
            };
        });
        jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({ errors: [], warnings: [] });

        const closeBundle = extractCloseBundle(
            getPlugins(
                getGetPluginsArg(
                    {
                        apps: {
                            // protectionLevel is null — only runAs should appear in manifest
                            permissions: {
                                protectionLevel: null as unknown as 'direct_publish',
                                runAs: '550e8400-e29b-41d4-a716-446655440000',
                            },
                        },
                    },
                    {
                        bundler: { ...getMockBundler({ name: 'vite' }), outDir },
                        buildRoot,
                        git: getRepositoryDataMock({ remote: 'git@github.com:org/repo.git' }),
                    },
                ),
            ),
        );
        await closeBundle();

        expect(manifest).toEqual({
            permissions: { runAs: '550e8400-e29b-41d4-a716-446655440000' },
            backend: { functions: {} },
        });
        expect((manifest as any).permissions).not.toHaveProperty('protectionLevel');
    });

    test('Should pass API credentials through when upload method is not specified', async () => {
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
        jest.spyOn(assets, 'collectAssets').mockResolvedValue([
            { absolutePath: '/project/dist/index.js', relativePath: 'dist/index.js' },
        ]);
        jest.spyOn(fsHelpers, 'rm').mockResolvedValue(undefined);
        jest.spyOn(archive, 'createArchive').mockResolvedValue({
            archivePath: '/tmp/dd-apps-123/datadog-apps-assets.zip',
            assets: [],
            size: 10,
        });
        jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({ errors: [], warnings: [] });

        await handleUpload({
            backendFunctions: [],
            backendOutputs: new Map(),
            context: getArgs().context,
            doAuthenticatedRequest: jest.fn(),
            options: {
                authOverrides: {
                    method: 'apiKey',
                },
                dryRun: false,
                include: [],
            },
        });

        expect(uploader.uploadArchive).toHaveBeenCalledWith(
            expect.objectContaining({ archivePath: '/tmp/dd-apps-123/datadog-apps-assets.zip' }),
            expect.objectContaining({
                doAuthenticatedRequest: expect.any(Function),
                site: DEFAULT_SITE,
            }),
            expect.anything(),
        );
    });

    test('Should write an archive for a trusted build service without uploading', async () => {
        const archiveOutput = '/tmp/preview-build/datadog-apps-assets.zip';
        process.env.DD_APPS_ARCHIVE_OUTPUT = archiveOutput;
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
        jest.spyOn(assets, 'collectAssets').mockResolvedValue([
            { absolutePath: '/project/dist/index.js', relativePath: 'dist/index.js' },
        ]);
        jest.spyOn(fsHelpers, 'rm').mockResolvedValue(undefined);
        jest.spyOn(archive, 'createArchive').mockResolvedValue({
            archivePath: '/tmp/dd-apps-123/datadog-apps-assets.zip',
            assets: [],
            size: 10,
        });
        const mkdir = jest.spyOn(fsp, 'mkdir').mockResolvedValue(undefined);
        const copyFile = jest.spyOn(fsp, 'copyFile').mockResolvedValue();
        const uploadArchive = jest
            .spyOn(uploader, 'uploadArchive')
            .mockResolvedValue({ errors: [], warnings: [] });

        try {
            await handleUpload({
                backendFunctions: [],
                backendOutputs: new Map(),
                context: getArgs().context,
                doAuthenticatedRequest: jest.fn(),
                options: {
                    authOverrides: {
                        method: 'oauth',
                    },
                    dryRun: true,
                    include: [],
                },
            });

            expect(mkdir).toHaveBeenCalledWith('/tmp/preview-build', {
                recursive: true,
            });
            expect(copyFile).toHaveBeenCalledWith(
                '/tmp/dd-apps-123/datadog-apps-assets.zip',
                archiveOutput,
            );
            expect(uploadArchive).not.toHaveBeenCalled();
        } finally {
            delete process.env.DD_APPS_ARCHIVE_OUTPUT;
        }
    });

    test('Should emit root manifest.json with backend function connection allowlists', async () => {
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
        jest.spyOn(assets, 'collectAssets').mockResolvedValue([
            { absolutePath: '/project/dist/index.js', relativePath: 'dist/index.js' },
        ]);
        jest.spyOn(fsHelpers, 'rm').mockResolvedValue(undefined);
        jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({
            errors: [],
            warnings: [],
        });

        let manifest: unknown;
        jest.spyOn(archive, 'createArchive').mockImplementation(async (archiveAssets) => {
            const manifestAsset = archiveAssets.find(
                (asset) => asset.relativePath === 'manifest.json',
            );
            expect(manifestAsset).toBeDefined();
            manifest = JSON.parse(await fsp.readFile(manifestAsset!.absolutePath, 'utf8'));
            return {
                archivePath: '/tmp/dd-apps-789/datadog-apps-assets.zip',
                assets: archiveAssets,
                size: 30,
            };
        });

        const backendCode = `
            import { request } from '@datadog/action-catalog/http/http';

            export function greet() {
                request({ connectionId: 'conn-b', inputs: {} });
            }

            export function salute() {
                request({ connectionId: 'conn-a', inputs: {} });
            }
        `;
        const viteBuild = jest.fn().mockImplementation(async (config) => {
            emitModuleParsed(config, '/project/src/backend/greet.backend.js', backendCode);
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
                resolve: jest.fn(async () => null),
                load: jest.fn(async () => null),
                addWatchFile: jest.fn(),
            },
            backendCode,
            '/project/src/backend/greet.backend.js',
        );

        await extractCloseBundle(plugins)();

        expect(archive.createArchive).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ relativePath: 'manifest.json' }),
                expect.objectContaining({
                    relativePath: expect.stringMatching(/^backend\/.*\.greet\.js$/),
                }),
            ]),
        );
        expect(
            Object.keys((manifest as { backend: { functions: object } }).backend.functions),
        ).toEqual([
            expect.stringMatching(/^[a-f0-9]{64}\.greet$/),
            expect.stringMatching(/^[a-f0-9]{64}\.salute$/),
        ]);
        expect(manifest).toMatchObject({
            backend: { functions: expect.any(Object) },
        });
        expect(
            Object.values(
                (manifest as { backend: { functions: Record<string, unknown> } }).backend.functions,
            ),
        ).toEqual([
            { allowedConnectionIds: ['conn-a', 'conn-b'] },
            { allowedConnectionIds: ['conn-a', 'conn-b'] },
        ]);
    });

    test('Should include reachable helper module connection allowlists in manifest.json', async () => {
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
        jest.spyOn(assets, 'collectAssets').mockResolvedValue([
            { absolutePath: '/project/dist/index.js', relativePath: 'dist/index.js' },
        ]);
        jest.spyOn(fsHelpers, 'rm').mockResolvedValue(undefined);
        jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({
            errors: [],
            warnings: [],
        });

        let manifest: unknown;
        jest.spyOn(archive, 'createArchive').mockImplementation(async (archiveAssets) => {
            const manifestAsset = archiveAssets.find(
                (asset) => asset.relativePath === 'manifest.json',
            );
            expect(manifestAsset).toBeDefined();
            manifest = JSON.parse(await fsp.readFile(manifestAsset!.absolutePath, 'utf8'));
            return {
                archivePath: '/tmp/dd-apps-790/datadog-apps-assets.zip',
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

    test('Should surface upload errors', async () => {
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
        const mockedAssets = [
            { absolutePath: '/project/dist/app.js', relativePath: 'dist/app.js' },
        ];
        jest.spyOn(assets, 'collectAssets').mockResolvedValue(mockedAssets);
        jest.spyOn(fsHelpers, 'rm').mockResolvedValue(undefined);
        jest.spyOn(archive, 'createArchive').mockResolvedValue({
            archivePath: '/tmp/dd-apps-456/datadog-apps-assets.zip',
            assets: mockedAssets,
            size: 20,
        });
        jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({
            errors: [new Error('upload failed')],
            warnings: [],
        });

        const closeBundle = extractCloseBundle(getPlugins(getArgs()));
        await expect(closeBundle()).rejects.toThrow('upload failed');

        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('upload failed'), 'error');
        expect(fsHelpers.rm).toHaveBeenCalledWith(path.resolve('/tmp/dd-apps-456'));
        expect(fsHelpers.rm).toHaveBeenCalledWith(expect.stringContaining('dd-apps-manifest-'));
    });

    test('Should upload assets with vite bundler', async () => {
        const intakeHost = `https://api.${DEFAULT_SITE}`;
        const uploadScope = nock(intakeHost).post(`/${APPS_API_PATH}/app-id/upload`).reply(200, {
            version_id: 'v123',
            application_id: 'app123',
            app_builder_id: 'builder123',
        });
        const releaseScope = nock(intakeHost)
            .put(`/${APPS_API_PATH}/app-id/release/live`)
            .reply(200, {});

        const { errors } = await runBundlers(
            { apps: { identifier: 'app-id', name: 'test-app', dryRun: false } },
            {},
            ['vite'],
        );

        expect(errors).toHaveLength(0);
        expect(uploadScope.isDone()).toBe(true);
        expect(releaseScope.isDone()).toBe(true);
    });
});
