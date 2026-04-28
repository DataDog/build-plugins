// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as archive from '@dd/apps-plugin/archive';
import * as assets from '@dd/apps-plugin/assets';
import * as extractConnections from '@dd/apps-plugin/backend/extract-connections';
import * as identifier from '@dd/apps-plugin/identifier';
import * as uploader from '@dd/apps-plugin/upload';
import { getPlugins } from '@dd/apps-plugin';
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
import nock from 'nock';
import path from 'path';

import { APPS_API_PATH } from './constants';

/** Extract and assert closeBundle from the first plugin's vite hooks. */
function extractCloseBundle(plugins: PluginOptions[]) {
    const plugin = plugins[0];
    expect(typeof plugin?.vite?.closeBundle).toBe('function');
    return plugin.vite!.closeBundle as () => Promise<void>;
}

/** Extract and assert buildStart from the first plugin's vite hooks. */
function extractBuildStart(plugins: PluginOptions[]) {
    const plugin = plugins[0];
    const buildStart = (plugin?.vite as { buildStart?: unknown } | undefined)?.buildStart;
    expect(typeof buildStart).toBe('function');
    return buildStart as (this: unknown) => Promise<void>;
}

/** Extract and assert configureServer from the first plugin's vite hooks. */
function extractConfigureServer(plugins: PluginOptions[]) {
    const plugin = plugins[0];
    const handler = (plugin?.vite as { configureServer?: unknown } | undefined)?.configureServer;
    expect(typeof handler).toBe('function');
    return handler as (server: {
        middlewares: { use: (fn: unknown) => void };
        transformRequest?: jest.Mock;
        watcher?: { on: jest.Mock };
    }) => void;
}

type WatcherEvent = 'add' | 'change' | 'unlink';

/**
 * Build a minimal mock dev server and capture chokidar listeners registered
 * via `server.watcher.on(...)`. The returned `listeners` map exposes them so
 * tests can fire watcher events without a real chokidar instance.
 */
function createMockServer(transformedCode: string | null) {
    const listeners = new Map<WatcherEvent, (file: string) => Promise<void>>();
    const transformRequest = jest
        .fn()
        .mockResolvedValue(transformedCode == null ? null : { code: transformedCode });
    const watcher: { on: jest.Mock } = {
        on: jest.fn((event: WatcherEvent, fn: (file: string) => Promise<void>) => {
            listeners.set(event, fn);
            return watcher;
        }),
    };
    return {
        server: {
            middlewares: { use: jest.fn() },
            transformRequest,
            watcher,
        },
        listeners,
        transformRequest,
        watcher,
    };
}

/** Build a minimal mock of the unplugin/Rollup PluginContext used by buildStart. */
function createMockPluginContext(loadedCode: string | null) {
    return {
        addWatchFile: jest.fn(),
        load: jest.fn().mockResolvedValue({ code: loadedCode }),
        parse: jest.fn().mockImplementation(() => ({
            // The actual extraction is asserted via the `extractConnectionIds`
            // spy in the calling test — `parse` just needs to return something
            // program-shaped that can flow through the buildStart hook.
            type: 'Program',
            sourceType: 'module',
            body: [],
        })),
    };
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
        jest.spyOn(archive, 'createArchive').mockResolvedValue({
            archivePath: '/tmp/dd-apps-123/datadog-apps-assets.zip',
            assets: mockedAssets,
            size: 10,
        });
        jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({
            errors: [],
            warnings: ['first warning'],
        });

        const closeBundle = extractCloseBundle(getPlugins(getArgs()));
        await closeBundle();

        expect(assets.collectAssets).toHaveBeenCalledWith(['dist/**/*'], buildRoot);
        expect(archive.createArchive).toHaveBeenCalledWith([
            {
                absolutePath: '/project/dist/index.js',
                relativePath: path.join('frontend', 'dist/index.js'),
            },
        ]);
        expect(uploader.uploadArchive).toHaveBeenCalledWith(
            expect.objectContaining({ archivePath: '/tmp/dd-apps-123/datadog-apps-assets.zip' }),
            {
                apiKey: '123',
                appKey: '123',
                bundlerName: 'vite',
                dryRun: true,
                identifier: 'repo:app',
                name: 'test-app',
                site: 'example.com',
                version: 'FAKE_VERSION',
            },
            expect.anything(),
        );
        expect(mockLogFn).toHaveBeenCalledWith(
            expect.stringContaining('Warnings while uploading assets'),
            'warn',
        );
        expect(fsHelpers.rm).toHaveBeenCalledWith(path.resolve('/tmp/dd-apps-123'));
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
    });

    describe('buildStart - connection IDs', () => {
        test('Should be a no-op when no connections file exists', async () => {
            const findSpy = jest
                .spyOn(extractConnections, 'findConnectionsFile')
                .mockResolvedValue(undefined);
            const extractSpy = jest.spyOn(extractConnections, 'extractConnectionIds');

            const buildStart = extractBuildStart(getPlugins(getArgs()));
            const ctx = createMockPluginContext(null);

            await buildStart.call(ctx);

            expect(findSpy).toHaveBeenCalledWith(buildRoot);
            expect(ctx.load).not.toHaveBeenCalled();
            expect(ctx.addWatchFile).not.toHaveBeenCalled();
            expect(extractSpy).not.toHaveBeenCalled();
        });

        test('Should load, parse, and extract IDs when connections file is present', async () => {
            const connectionsPath = path.join(buildRoot, 'connections.ts');
            jest.spyOn(extractConnections, 'findConnectionsFile').mockResolvedValue(
                connectionsPath,
            );
            const extractSpy = jest
                .spyOn(extractConnections, 'extractConnectionIds')
                .mockReturnValue(['uuid-a', 'uuid-b']);

            const buildStart = extractBuildStart(getPlugins(getArgs()));
            const ctx = createMockPluginContext('export const connections = {} as const;');

            await buildStart.call(ctx);

            expect(ctx.addWatchFile).toHaveBeenCalledWith(connectionsPath);
            expect(ctx.load).toHaveBeenCalledWith({ id: connectionsPath });
            expect(ctx.parse).toHaveBeenCalledWith('export const connections = {} as const;');
            expect(extractSpy).toHaveBeenCalled();
        });

        test('Should throw when ctx.load returns no code for the connections file', async () => {
            const connectionsPath = path.join(buildRoot, 'connections.ts');
            jest.spyOn(extractConnections, 'findConnectionsFile').mockResolvedValue(
                connectionsPath,
            );

            const buildStart = extractBuildStart(getPlugins(getArgs()));
            const ctx = createMockPluginContext(null);

            await expect(buildStart.call(ctx)).rejects.toThrow(
                `connections file '${connectionsPath}' produced no code when loaded`,
            );
        });

        // Vite's dev plugin context returns a ModuleInfo proxy whose `code`
        // getter throws — code is only resolvable through the dev server's
        // transformRequest. configureServer fires before buildStart in dev,
        // so the loader uses the captured server instead of this.load.
        test('Should use server.transformRequest in dev (after configureServer fires)', async () => {
            const connectionsPath = path.join(buildRoot, 'connections.ts');
            jest.spyOn(extractConnections, 'findConnectionsFile').mockResolvedValue(
                connectionsPath,
            );
            const extractSpy = jest
                .spyOn(extractConnections, 'extractConnectionIds')
                .mockReturnValue(['uuid-from-dev']);

            const plugins = getPlugins(getArgs());
            const configureServer = extractConfigureServer(plugins);
            const transformRequest = jest
                .fn()
                .mockResolvedValue({ code: 'export const connections = {};' });
            configureServer({
                middlewares: { use: jest.fn() },
                transformRequest,
                watcher: { on: jest.fn() },
            });

            const buildStart = extractBuildStart(plugins);
            // ctx.load returns a ModuleInfo whose `code` getter throws —
            // mirrors vite's EnvironmentPluginContainer proxy.
            const moduleInfoStub = Object.defineProperty({}, 'code', {
                get() {
                    throw new Error('[vite] The "code" property of ModuleInfo is not supported.');
                },
            });
            const ctx = {
                addWatchFile: jest.fn(),
                load: jest.fn().mockResolvedValue(moduleInfoStub),
                parse: jest.fn().mockReturnValue({
                    type: 'Program',
                    sourceType: 'module',
                    body: [],
                }),
            };

            await buildStart.call(ctx);

            expect(transformRequest).toHaveBeenCalledWith(connectionsPath);
            expect(ctx.load).not.toHaveBeenCalled();
            expect(ctx.addWatchFile).toHaveBeenCalledWith(connectionsPath);
            expect(extractSpy).toHaveBeenCalled();
        });

        // Strict-validation throws need to surface in the build log because
        // downstream plugins (e.g. error-tracking sourcemaps) can throw their
        // own errors during teardown and mask ours from vite's final report.
        test('Should log the framed error before re-throwing', async () => {
            const connectionsPath = path.join(buildRoot, 'connections.ts');
            jest.spyOn(extractConnections, 'findConnectionsFile').mockResolvedValue(
                connectionsPath,
            );
            jest.spyOn(extractConnections, 'extractConnectionIds').mockImplementation(() => {
                throw new Error('[connections] bad value (at /project/connections.ts:3:8)');
            });

            const buildStart = extractBuildStart(getPlugins(getArgs()));
            const ctx = createMockPluginContext('export const connections = {};');

            await expect(buildStart.call(ctx)).rejects.toThrow(
                '[connections] bad value (at /project/connections.ts:3:8)',
            );
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('[connections] bad value (at /project/connections.ts:3:8)'),
                'error',
            );
        });
    });

    describe('configureServer - connection-file watcher', () => {
        const connectionsPath = path.join(buildRoot, 'connections.ts');

        // Wire up configureServer + buildStart so the parser is captured (the
        // refresh path needs it). Returns the watcher listener map and the
        // connectionRegistry-driven middleware getConnectionIds closure for
        // assertions on the registry's post-event state.
        const setup = async (transformedCode: string | null = '') => {
            const plugins = getPlugins(getArgs());
            const mock = createMockServer(transformedCode);
            extractConfigureServer(plugins)(mock.server);

            // primeParser via buildStart — start with no connections file so
            // buildStart succeeds without touching extractConnectionIds.
            jest.spyOn(extractConnections, 'findConnectionsFile').mockResolvedValueOnce(undefined);
            await extractBuildStart(plugins).call(createMockPluginContext(null));

            // Capture getConnectionIds from the middleware passed to use().
            const middlewareCalls = (mock.server.middlewares.use as jest.Mock).mock.calls;
            expect(middlewareCalls.length).toBeGreaterThan(0);

            return mock;
        };

        test('Should ignore unrelated file changes', async () => {
            const findSpy = jest.spyOn(extractConnections, 'findConnectionsFile');
            const extractSpy = jest.spyOn(extractConnections, 'extractConnectionIds');

            const mock = await setup();
            findSpy.mockClear();

            await mock.listeners.get('change')!(path.join(buildRoot, 'src/some-other-file.ts'));

            // Basename filter must short-circuit before any disk lookup.
            expect(findSpy).not.toHaveBeenCalled();
            expect(extractSpy).not.toHaveBeenCalled();
            expect(mock.transformRequest).not.toHaveBeenCalled();
        });

        test('Should ignore connections.ts in subdirectories (only project-root file)', async () => {
            const findSpy = jest.spyOn(extractConnections, 'findConnectionsFile');

            const mock = await setup();
            findSpy.mockClear();

            await mock.listeners.get('change')!(path.join(buildRoot, 'src/connections.ts'));

            expect(findSpy).not.toHaveBeenCalled();
            expect(mock.transformRequest).not.toHaveBeenCalled();
        });

        test('Should refresh connection IDs when connections.ts changes', async () => {
            jest.spyOn(extractConnections, 'findConnectionsFile').mockResolvedValue(
                connectionsPath,
            );
            const extractSpy = jest
                .spyOn(extractConnections, 'extractConnectionIds')
                .mockReturnValue(['fresh-uuid-1', 'fresh-uuid-2']);

            const mock = await setup("export const connections = { A: 'fresh-uuid-1' };");

            await mock.listeners.get('change')!(connectionsPath);

            expect(mock.transformRequest).toHaveBeenCalledWith(connectionsPath);
            expect(extractSpy).toHaveBeenCalledWith(
                expect.anything(),
                connectionsPath,
                "export const connections = { A: 'fresh-uuid-1' };",
            );
        });

        test('Should refresh connection IDs when connections.ts is created (add event)', async () => {
            jest.spyOn(extractConnections, 'findConnectionsFile').mockResolvedValue(
                connectionsPath,
            );
            const extractSpy = jest
                .spyOn(extractConnections, 'extractConnectionIds')
                .mockReturnValue(['new-uuid']);

            const mock = await setup("export const connections = { A: 'new-uuid' };");

            await mock.listeners.get('add')!(connectionsPath);

            expect(mock.transformRequest).toHaveBeenCalledWith(connectionsPath);
            expect(extractSpy).toHaveBeenCalled();
        });

        test('Should clear registry when connections.ts is deleted (unlink event)', async () => {
            // First, populate the registry via a successful change refresh.
            jest.spyOn(extractConnections, 'findConnectionsFile').mockResolvedValue(
                connectionsPath,
            );
            jest.spyOn(extractConnections, 'extractConnectionIds').mockReturnValue(['uuid-x']);

            const mock = await setup("export const connections = { A: 'uuid-x' };");
            await mock.listeners.get('change')!(connectionsPath);

            // Now simulate the file going away — findConnectionsFile returns
            // undefined, so loadAndSetConnectionIds clears the registry.
            jest.spyOn(extractConnections, 'findConnectionsFile').mockResolvedValue(undefined);
            await mock.listeners.get('unlink')!(connectionsPath);

            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('Cleared connection IDs (no connections file present)'),
                'debug',
            );
        });

        test('Should clear registry on extraction failure (allowlist fail-closed)', async () => {
            jest.spyOn(extractConnections, 'findConnectionsFile').mockResolvedValue(
                connectionsPath,
            );
            // First successful refresh seeds the registry.
            const extractSpy = jest
                .spyOn(extractConnections, 'extractConnectionIds')
                .mockReturnValueOnce(['uuid-good']);

            const mock = await setup("export const connections = { A: 'uuid-good' };");
            await mock.listeners.get('change')!(connectionsPath);

            // Subsequent edit fails — registry must be cleared, not retained.
            extractSpy.mockImplementationOnce(() => {
                throw new Error('boom');
            });
            mock.transformRequest.mockResolvedValueOnce({ code: 'broken' });

            await mock.listeners.get('change')!(connectionsPath);

            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining(
                    'Failed to refresh connection IDs (cleared registry): boom',
                ),
                'error',
            );
        });

        test('Should log error when transformRequest returns null', async () => {
            jest.spyOn(extractConnections, 'findConnectionsFile').mockResolvedValue(
                connectionsPath,
            );
            const extractSpy = jest.spyOn(extractConnections, 'extractConnectionIds');

            const mock = await setup(null);

            await mock.listeners.get('change')!(connectionsPath);

            expect(extractSpy).not.toHaveBeenCalled();
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('Failed to refresh connection IDs (cleared registry):'),
                'error',
            );
        });
    });

    test('Should upload assets with vite bundler', async () => {
        const intakeHost = 'https://api.example.com';
        const scope = nock(intakeHost).post(`/${APPS_API_PATH}/app-id/upload`).reply(200, {
            version_id: 'v123',
            application_id: 'app123',
            app_builder_id: 'builder123',
        });

        const { errors } = await runBundlers(
            { apps: { identifier: 'app-id', name: 'test-app', dryRun: false } },
            {},
            ['vite'],
        );

        expect(errors).toHaveLength(0);
        expect(scope.isDone()).toBe(true);
    });
});
