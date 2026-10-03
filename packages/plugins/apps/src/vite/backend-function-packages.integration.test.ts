// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Backend functions shipped by an npm package, exercised the way an app consumes them: a real
 * `vite build` and a real Vite dev server, configured with the published `datadogVitePlugin`,
 * against an app that installs the `apps_backend_library_project` fixture packages.
 */

import { datadogVitePlugin } from '@datadog/vite-plugin';
import { createMockRequest, createMockResponse } from '@dd/tests/_jest/helpers/mocks';
import fsp from 'fs/promises';
import fs from 'fs';
import JSZip from 'jszip';
import nock from 'nock';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { build, createServer, type ViteDevServer } from 'vite';

import { ARCHIVE_FILENAME } from '../constants';
import type { AppsManifest } from '../types';

const FIXTURES_DIR = path.resolve(__dirname, '../../../../tests/src/_jest/fixtures');
const PROJECT_DIR = path.join(FIXTURES_DIR, 'apps_backend_library_project');
const ACTION_CATALOG_DIR = path.join(FIXTURES_DIR, 'action_catalog_project');

// Only exists in the library's backend function body, never in its proxy.
const VIZ_BACKEND_BODY = 'viz-lib backend body';
const PLAIN_LIB_BODY = 'plain-backend-lib ordinary module body';
const QUERY = 'avg:system.cpu.user{*}';
const PROXY_CALL_RE = /executeBackendFunction\("([0-9a-f]{64}\.[A-Za-z]+)"/g;

type Layout = 'installed' | 'linked';

/**
 * Assembles the app in a temp dir. `installed` copies every package into `node_modules`, as npm or
 * a tarball install would. `linked` symlinks the viz library from its own checkout, which has its
 * own development copy of `@datadog/action-catalog` (as `npm link` or a `file:` dependency would).
 */
async function assembleApp(
    layout: Layout,
): Promise<{ appRoot: string; cleanup: () => Promise<void> }> {
    const tempDir = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'dd-apps-library-')));
    const appRoot = path.join(tempDir, 'app');
    const copy = (from: string, to: string) => fsp.cp(from, to, { recursive: true });
    const install = (from: string, name: string) =>
        copy(from, path.join(appRoot, 'node_modules', name));

    await copy(path.join(PROJECT_DIR, 'app'), appRoot);
    await install(ACTION_CATALOG_DIR, '@datadog/action-catalog');
    await install(path.join(PROJECT_DIR, 'packages/plain-lib'), 'plain-backend-lib');
    await install(path.join(PROJECT_DIR, 'packages/banned-lib'), '@fixtures/banned-lib');

    const vizLibSource = path.join(PROJECT_DIR, 'packages/viz-lib');
    if (layout === 'installed') {
        await install(vizLibSource, '@fixtures/viz-lib');
    } else {
        const checkout = path.join(tempDir, 'viz-lib');
        await copy(vizLibSource, checkout);
        await copy(ACTION_CATALOG_DIR, path.join(checkout, 'node_modules/@datadog/action-catalog'));
        const link = path.join(appRoot, 'node_modules/@fixtures/viz-lib');
        await fsp.mkdir(path.dirname(link), { recursive: true });
        await fsp.symlink(checkout, link, 'dir');
    }

    return { appRoot, cleanup: () => fsp.rm(tempDir, { recursive: true, force: true }) };
}

function getAppsPlugin() {
    return datadogVitePlugin({ logLevel: 'error', apps: { enable: true } });
}

async function buildApp(appRoot: string, entry: string) {
    await build({
        root: appRoot,
        configFile: false,
        logLevel: 'silent',
        build: {
            outDir: 'dist',
            emptyOutDir: true,
            minify: false,
            rollupOptions: { input: path.join(appRoot, entry) },
        },
        plugins: [getAppsPlugin()],
    });

    const outDir = path.join(appRoot, 'dist');
    const zip = await JSZip.loadAsync(await fsp.readFile(path.join(outDir, ARCHIVE_FILENAME)));
    const readEntry = (name: string) => {
        const file = zip.file(name);
        if (!file) {
            throw new Error(`Expected ${name} in the app package.`);
        }
        return file.async('string');
    };
    const manifest: AppsManifest = JSON.parse(await readEntry('manifest.json'));
    const frontendNames = Object.values(zip.files)
        .filter((file) => !file.dir && file.name.startsWith('frontend/'))
        .map((file) => file.name);
    const frontendCode = (await Promise.all(frontendNames.map(readEntry))).join('\n');
    return { manifest, frontendCode, readEntry };
}

function getProxiedQueryNames(code: string): string[] {
    return [...code.matchAll(PROXY_CALL_RE)].map((match) => match[1]);
}

type BackendMain = (context: unknown) => Promise<unknown>;

async function importBackendMain(code: string, dir: string): Promise<BackendMain> {
    const file = path.join(dir, 'backend-function.js');
    await fsp.writeFile(file, code);
    const mod: unknown = await import(pathToFileURL(file).href);
    if (
        typeof mod !== 'object' ||
        mod === null ||
        !('main' in mod) ||
        typeof mod.main !== 'function'
    ) {
        throw new Error('Expected the backend bundle to export main().');
    }
    const { main } = mod;
    return (context) => Promise.resolve(main(context));
}

/**
 * Loads every module a browser would, starting at `entryUrl`, by following the import URLs in the
 * dev server's client-side output. Returns the concatenated code it was served.
 */
async function loadClientModuleGraph(server: ViteDevServer, entryUrl: string): Promise<string> {
    const seen = new Set<string>();
    const pending = [entryUrl];
    const served: string[] = [];
    while (pending.length > 0) {
        const url = pending.shift()!;
        if (seen.has(url) || url.startsWith('/@vite/')) {
            continue;
        }
        seen.add(url);
        // eslint-disable-next-line no-await-in-loop
        const result = await server.transformRequest(url);
        if (!result) {
            throw new Error(`The dev server served nothing for ${url}.`);
        }
        served.push(result.code);
        // Static (`from "x"`, `import "x"`) and dynamic (`import("x")`) imports alike.
        for (const match of result.code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
            pending.push(match[1]);
        }
    }
    return served.join('\n');
}

const previewRuntimeContext = {
    Source: {
        initiator: { id: 'initiator', orgId: 'org' },
        runAsUser: { id: 'run-as', orgId: 'org' },
    },
};

function getField(value: unknown, key: string): unknown {
    return typeof value === 'object' && value !== null && key in value
        ? Reflect.get(value, key)
        : undefined;
}

/** The query spec of a preview-async request body: `data.attributes.query.properties.spec`. */
function getSpec(body: unknown): { fqn?: unknown; connectionId?: unknown } {
    const spec = ['data', 'attributes', 'query', 'properties', 'spec'].reduce(getField, body);
    return {
        fqn: getField(spec, 'fqn'),
        connectionId: getField(spec, 'connectionId'),
    };
}

/** Mocks Datadog's preview API: runtime-context hydration, then the metrics action itself. */
function mockDatadogApi(series: unknown) {
    const actionCalls: unknown[] = [];
    const api = nock('https://api.datadoghq.com')
        .post(
            '/api/v2/app-builder/queries/preview-async',
            (body) =>
                getSpec(body).fqn === 'com.datadoghq.datatransformation.jsFunctionWithActions',
        )
        .reply(200, { data: { id: 'runtime-context' } })
        .get('/api/v2/app-builder/queries/execution-long-polling/runtime-context')
        .reply(200, {
            data: { attributes: { done: true, outputs: { data: previewRuntimeContext } } },
        })
        .post('/api/v2/app-builder/queries/preview-async', (body) => {
            const spec = getSpec(body);
            if (spec.fqn !== 'com.datadoghq.dd.metrics.queryTimeseriesData') {
                return false;
            }
            actionCalls.push(spec);
            return true;
        })
        .reply(200, { data: { id: 'metrics-action' } })
        .get('/api/v2/app-builder/queries/execution-long-polling/metrics-action')
        .reply(200, { data: { attributes: { done: true, outputs: series } } });
    return { api, actionCalls };
}

describe.each<Layout>(['installed', 'linked'])(
    'Backend functions shipped by a package (%s layout)',
    (layout) => {
        let appRoot: string;
        let cleanup: () => Promise<void>;
        let built: Awaited<ReturnType<typeof buildApp>>;
        let scratchDir: string;

        beforeAll(async () => {
            ({ appRoot, cleanup } = await assembleApp(layout));
            scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dd-apps-library-bundle-'));
            built = await buildApp(appRoot, 'main.ts');
        }, 60000);

        afterAll(async () => {
            await cleanup();
            await fsp.rm(scratchDir, { recursive: true, force: true });
        });

        describe('vite build', () => {
            test('Should package an opted-in library function with the connection IDs its own modules declare', () => {
                const functionNames = Object.keys(built.manifest.backend.functions);
                expect(functionNames).toEqual([expect.stringMatching(/\.fetchSeries$/)]);
                expect(built.manifest.backend.functions[functionNames[0]]).toEqual({
                    allowedConnectionIds: ['viz-lib-metrics-connection'],
                });
            });

            test('Should give the frontend a proxy for the library function instead of its body', () => {
                expect(getProxiedQueryNames(built.frontendCode)).toEqual(
                    Object.keys(built.manifest.backend.functions),
                );
                expect(built.frontendCode).not.toContain(VIZ_BACKEND_BODY);
            });

            test("Should keep a .backend.js file in a package that didn't opt in as an ordinary module", () => {
                expect(built.frontendCode).toContain(PLAIN_LIB_BODY);
                expect(Object.keys(built.manifest.backend.functions)).not.toContainEqual(
                    expect.stringMatching(/\.describeOrdinary$/),
                );
            });

            test("Should run the packaged function's action through the app's own action catalog", async () => {
                const [queryName] = Object.keys(built.manifest.backend.functions);
                const code = await built.readEntry(`backend/${queryName}.js`);
                const main = await importBackendMain(code, scratchDir);
                const queryTimeseriesData = jest.fn(async () => ({ points: [1, 2, 3] }));

                const result = await main({
                    Actions: { dd: { metrics: { queryTimeseriesData } } },
                    Source: previewRuntimeContext.Source,
                    backendFunctionArgs: [QUERY],
                });

                expect(queryTimeseriesData).toHaveBeenCalledWith({
                    inputs: { query: QUERY, from: 0, to: 60 },
                    connectionId: 'viz-lib-metrics-connection',
                });
                expect(result).toEqual({
                    query: QUERY,
                    series: { points: [1, 2, 3] },
                    servedBy: VIZ_BACKEND_BODY,
                });
            });

            test("Should reject a banned import in an opted-in library's backend code", async () => {
                await expect(buildApp(appRoot, 'banned.ts')).rejects.toThrow(
                    'Importing Node built-in module "fs" is not supported in backend function code',
                );
            }, 30000);
        });

        describe('vite dev', () => {
            let server: ViteDevServer;

            beforeAll(async () => {
                process.env.DD_API_KEY = 'test-api-key';
                process.env.DD_APP_KEY = 'test-app-key';
                server = await createServer({
                    root: appRoot,
                    configFile: false,
                    logLevel: 'silent',
                    server: { middlewareMode: true, hmr: false },
                    plugins: [getAppsPlugin()],
                });
            }, 30000);

            afterAll(async () => {
                await server.close();
            });

            afterEach(() => {
                nock.cleanAll();
            });

            test('Should serve the browser a proxy for the library function, named as in the build, and the plain package as is', async () => {
                const clientCode = await loadClientModuleGraph(server, '/main.ts');

                expect(getProxiedQueryNames(clientCode)).toEqual(
                    Object.keys(built.manifest.backend.functions),
                );
                expect(clientCode).not.toContain(VIZ_BACKEND_BODY);
                expect(clientCode).toContain(PLAIN_LIB_BODY);
            }, 30000);

            test('Should execute the library function locally through /__dd/executeAction', async () => {
                const [queryName] = getProxiedQueryNames(
                    await loadClientModuleGraph(server, '/main.ts'),
                );
                const { api, actionCalls } = mockDatadogApi({ points: [4, 5, 6] });

                const req = createMockRequest('/__dd/executeAction', {
                    functionName: queryName,
                    args: [QUERY],
                });
                const res = createMockResponse();
                server.middlewares(req, res, jest.fn());
                await res.done;

                expect(JSON.parse(res.getBody())).toEqual({
                    success: true,
                    result: {
                        data: {
                            query: QUERY,
                            series: { points: [4, 5, 6] },
                            servedBy: VIZ_BACKEND_BODY,
                        },
                    },
                });
                expect(actionCalls).toEqual([
                    expect.objectContaining({ connectionId: 'viz-lib-metrics-connection' }),
                ]);
                expect(api.isDone()).toBe(true);
            }, 30000);
        });
    },
);
