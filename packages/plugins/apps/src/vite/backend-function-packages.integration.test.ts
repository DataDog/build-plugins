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
import { parseAst } from 'rollup/parseAst';
import { pathToFileURL } from 'url';
import { build, createServer, type ViteDevServer } from 'vite';

import { ARCHIVE_FILENAME } from '../constants';
import type { AppsManifest } from '../types';

// Jest compiles loadViteParseAst's dynamic import into a `require`, which gets Vite's CJS
// entry and no `parseAst`; the published build keeps the real import.
jest.mock('@dd/apps-plugin/vite/vite-parse-ast', () => ({
    loadViteParseAst: async () => parseAst,
}));

const FIXTURES_DIR = path.resolve(__dirname, '../../../../tests/src/_jest/fixtures');
const PROJECT_DIR = path.join(FIXTURES_DIR, 'apps_backend_library_project');
const ACTION_CATALOG_DIR = path.join(FIXTURES_DIR, 'action_catalog_project');

// Only exists in the library's backend function body, never in its proxy.
const VIZ_BACKEND_BODY = 'viz-lib backend body';
const PLAIN_LIB_BODY = 'plain-backend-lib ordinary module body';
const LINKED_PLAIN_LIB_BODY = 'linked-plain-backend-lib module body';
const QUERY = 'avg:system.cpu.user{*}';
const PROXY_CALL_RE = /executeBackendFunction\("([0-9a-f]{64}\.[A-Za-z]+)"/g;

type Layout = 'installed' | 'linked';

/**
 * Assembles the app in a temp dir. `installed` copies every package into `node_modules`, as npm or
 * a tarball install would. `linked` symlinks the viz library from its own checkout, which has its
 * own development copy of `@datadog/action-catalog` (as `npm link` or a `file:` dependency would).
 * In both, the non-opted `linked-plain-backend-lib` is symlinked from a checkout beside the app.
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
    await install(path.join(PROJECT_DIR, 'packages/hooks-lib'), '@fixtures/hooks-lib');
    await install(path.join(PROJECT_DIR, 'packages/viz-lib'), 'viz-alias');

    const link = async (checkout: string, name: string) => {
        const linkPath = path.join(appRoot, 'node_modules', name);
        await fsp.mkdir(path.dirname(linkPath), { recursive: true });
        await fsp.symlink(checkout, linkPath, 'dir');
    };
    const linkedPlainCheckout = path.join(tempDir, 'linked-plain-lib');
    await copy(path.join(PROJECT_DIR, 'packages/linked-plain-lib'), linkedPlainCheckout);
    await link(linkedPlainCheckout, 'linked-plain-backend-lib');

    const vizLibSource = path.join(PROJECT_DIR, 'packages/viz-lib');
    if (layout === 'installed') {
        await install(vizLibSource, '@fixtures/viz-lib');
    } else {
        const checkout = path.join(tempDir, 'viz-lib');
        await copy(vizLibSource, checkout);
        await copy(ACTION_CATALOG_DIR, path.join(checkout, 'node_modules/@datadog/action-catalog'));
        await link(checkout, '@fixtures/viz-lib');
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
            sourcemap: true,
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
        // Code only: with sourcemaps on, a map's sourcesContent would match source text too.
        .filter(
            (file) => !file.dir && file.name.startsWith('frontend/') && !file.name.endsWith('.map'),
        )
        .map((file) => file.name);
    const frontendCode = (await Promise.all(frontendNames.map(readEntry))).join('\n');
    const mapNames = (await fsp.readdir(outDir, { recursive: true })).filter((name) =>
        name.endsWith('.map'),
    );
    const sourcemaps: Array<{ sources: string[]; sourcesContent?: Array<string | null> }> =
        await Promise.all(
            mapNames.map(async (name) =>
                JSON.parse(await fsp.readFile(path.join(outDir, name), 'utf-8')),
            ),
        );
    return { manifest, frontendCode, sourcemaps, readEntry };
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
function getSpec(body: unknown): { fqn?: unknown; connectionId?: unknown; inputs?: unknown } {
    const spec = ['data', 'attributes', 'query', 'properties', 'spec'].reduce(getField, body);
    return {
        fqn: getField(spec, 'fqn'),
        connectionId: getField(spec, 'connectionId'),
        inputs: getField(spec, 'inputs'),
    };
}

/** Waits until Vite's SSR module graph has invalidated `file` after a change event. */
async function waitForInvalidation(server: ViteDevServer, file: string): Promise<void> {
    const deadline = Date.now() + 5000;
    const isInvalidated = () => {
        const nodes = server.environments.ssr.moduleGraph.getModulesByFile(file) ?? new Set();
        return [...nodes].some((node) => node.lastInvalidationTimestamp > 0);
    };
    while (!isInvalidated()) {
        if (Date.now() > deadline) {
            throw new Error(`Vite never invalidated ${file}`);
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
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

            test("Should map the frontend to the library's frontend sources, but to none of its backend files", async () => {
                const sources = built.sourcemaps.flatMap((map) => map.sources);
                const vizLibDir = fs.realpathSync(
                    path.join(appRoot, 'node_modules/@fixtures/viz-lib'),
                );
                const backendTexts = await Promise.all(
                    ['data.backend.js', 'request.js'].map((file) =>
                        fsp.readFile(
                            path.join(vizLibDir, 'dist/src/visualizations', file),
                            'utf-8',
                        ),
                    ),
                );
                const contents = built.sourcemaps.flatMap((map) => map.sourcesContent ?? []);

                expect(sources).toContainEqual(
                    expect.stringMatching(/viz-lib\/dist\/src\/index\.js$/),
                );
                expect(sources.filter((source) => source.includes('visualizations/'))).toEqual([]);
                for (const text of backendTexts) {
                    expect(contents.filter((content) => content?.includes(text))).toEqual([]);
                }
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

            // Vite serves an excluded package's modules with a `?v=` query and immutable caching, so
            // after a restart a browser can call through its cached proxy without requesting the
            // module from the new server. That holds for each installed copy of the library, even
            // two sharing a name.
            test('Should execute the library function after a restart, for a browser that kept its cached proxy', async () => {
                const hooksLibDir = path.join(appRoot, 'node_modules/@fixtures/hooks-lib');
                const hooksManifestPath = path.join(hooksLibDir, 'package.json');
                const hooksManifest = JSON.parse(await fsp.readFile(hooksManifestPath, 'utf-8'));
                const nestedManifest = {
                    ...hooksManifest,
                    dependencies: { '@fixtures/viz-lib': '0.0.1' },
                };
                await fsp.writeFile(hooksManifestPath, JSON.stringify(nestedManifest));
                const vizLibSource = path.join(PROJECT_DIR, 'packages/viz-lib');
                const nestedVizLib = path.join(hooksLibDir, 'node_modules/@fixtures/viz-lib');
                await fsp.cp(vizLibSource, nestedVizLib, { recursive: true });

                const [queryName] = getProxiedQueryNames(
                    await loadClientModuleGraph(server, '/main.ts'),
                );
                const nestedProxy = await loadClientModuleGraph(
                    server,
                    '/node_modules/@fixtures/hooks-lib/node_modules/@fixtures/viz-lib/dist/src/visualizations/data.backend.js',
                );
                const [nestedQueryName] = getProxiedQueryNames(nestedProxy);
                expect(nestedQueryName).toBeDefined();
                expect(nestedQueryName).not.toBe(queryName);

                const restarted = await createServer({
                    root: appRoot,
                    configFile: false,
                    logLevel: 'silent',
                    server: { middlewareMode: true, hmr: false },
                    plugins: [getAppsPlugin()],
                });
                try {
                    for (const functionName of [queryName, nestedQueryName]) {
                        const { api } = mockDatadogApi({ points: [7] });
                        const req = createMockRequest('/__dd/executeAction', {
                            functionName,
                            args: [QUERY],
                        });
                        const res = createMockResponse();
                        restarted.middlewares(req, res, jest.fn());
                        // eslint-disable-next-line no-await-in-loop
                        await res.done;

                        expect(JSON.parse(res.getBody())).toEqual({
                            success: true,
                            result: {
                                data: {
                                    query: QUERY,
                                    series: { points: [7] },
                                    servedBy: VIZ_BACKEND_BODY,
                                },
                            },
                        });
                        expect(api.isDone()).toBe(true);
                    }
                } finally {
                    await restarted.close();
                }
            }, 30000);

            // Last in this block: it edits the installed (or linked) library in place.
            test("Should run the library's edited modules on the next local execution", async () => {
                const [queryName] = getProxiedQueryNames(
                    await loadClientModuleGraph(server, '/main.ts'),
                );
                const execute = async () => {
                    const { api, actionCalls } = mockDatadogApi({ points: [] });
                    const req = createMockRequest('/__dd/executeAction', {
                        functionName: queryName,
                        args: [QUERY],
                    });
                    const res = createMockResponse();
                    server.middlewares(req, res, jest.fn());
                    await res.done;
                    expect(api.isDone()).toBe(true);
                    return actionCalls;
                };
                const helperFile = fs.realpathSync(
                    path.join(
                        appRoot,
                        'node_modules/@fixtures/viz-lib/dist/src/visualizations/request.js',
                    ),
                );

                expect(await execute()).toEqual([
                    expect.objectContaining({ inputs: { query: QUERY, from: 0, to: 60 } }),
                ]);

                const source = await fsp.readFile(helperFile, 'utf-8');
                await fsp.writeFile(helperFile, source.replace('to: 60', 'to: 120'));
                server.watcher.emit('change', helperFile);
                await waitForInvalidation(server, helperFile);

                expect(await execute()).toEqual([
                    expect.objectContaining({ inputs: { query: QUERY, from: 0, to: 120 } }),
                ]);
            }, 30000);
        });
    },
);

describe('Backend functions shipped by a package: refusals and subfolders', () => {
    let appRoot: string;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
        ({ appRoot, cleanup } = await assembleApp('installed'));
    });

    afterAll(async () => {
        await cleanup();
    });

    // Upstream's rule: a linked workspace file outside the root is always proxied, opt-in or
    // not, and the graph checks then refuse it, so it fails closed instead of deploying.
    test("Should fail the build for a linked .backend.js in a package that didn't opt in, without shipping its body", async () => {
        const outDir = path.join(appRoot, 'dist');

        await expect(buildApp(appRoot, 'linked-plain.ts')).rejects.toThrow(
            /missing module record for \S+linked\.backend\.js/,
        );

        // Vite wrote the frontend before packaging failed: it holds only the proxy.
        const outputNames = await fsp.readdir(outDir, { recursive: true });
        const frontendFiles = outputNames.filter((name) => name.endsWith('.js'));
        const frontendOutput = (
            await Promise.all(
                frontendFiles.map((name) => fsp.readFile(path.join(outDir, name), 'utf-8')),
            )
        ).join('\n');
        expect(getProxiedQueryNames(frontendOutput)).toEqual([
            expect.stringMatching(/\.describeLinked$/),
        ]);
        expect(frontendOutput).not.toContain(LINKED_PLAIN_LIB_BODY);
        expect(outputNames).not.toContain(ARCHIVE_FILENAME);
    }, 30000);

    test("Should package a function in a subfolder with its own named package.json, under the package root's opt-in", async () => {
        const hooks = await buildApp(appRoot, 'hooks.ts');

        const functionNames = Object.keys(hooks.manifest.backend.functions);
        expect(functionNames).toEqual([expect.stringMatching(/\.readHookState$/)]);
        expect(getProxiedQueryNames(hooks.frontendCode)).toEqual(functionNames);
        expect(hooks.frontendCode).not.toContain('hooks-lib backend body');
    }, 30000);

    // Pre-bundling resolves the alias, not the manifest name, so excluding only the latter would
    // inline the backend body into the browser's dependency chunk.
    test('Should serve a proxy, not the body, for a library installed under an npm alias in vite dev', async () => {
        const server = await createServer({
            root: appRoot,
            configFile: false,
            logLevel: 'silent',
            server: { middlewareMode: true, hmr: false },
            plugins: [getAppsPlugin()],
        });
        try {
            const clientCode = await loadClientModuleGraph(server, '/alias.ts');

            expect(getProxiedQueryNames(clientCode)).toEqual([
                expect.stringMatching(/\.fetchSeries$/),
            ]);
            expect(clientCode).not.toContain(VIZ_BACKEND_BODY);
        } finally {
            await server.close();
        }
    }, 30000);

    test("Should reject a banned import in an opted-in library's backend code", async () => {
        await expect(buildApp(appRoot, 'banned.ts')).rejects.toThrow(
            'Importing Node built-in module "fs" is not supported in backend function code',
        );
    }, 30000);
});
