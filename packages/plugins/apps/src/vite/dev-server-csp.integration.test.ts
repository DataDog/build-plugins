// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { CSP_VIOLATION_LOGGER_ID } from '@dd/apps-plugin/vite/dev-server-csp-violations';
import {
    getAppCspDirective,
    getDirective,
    getPreamble,
    httpGet,
    sha256Source,
} from '@dd/apps-plugin/vite/dev-server-csp.fixtures';
import { APP_CSP_HEADER, SELF_SERVED_APP_TYPE } from '@dd/apps-plugin/vite/dev-server-csp';
import { getVitePlugin } from '@dd/apps-plugin/vite/index';
import { outputFileSync, rmSync } from '@dd/core/helpers/fs';
import { clearDatadogEnv } from '@dd/tests/_jest/helpers/datadogEnv';
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import { getContextMock } from '@dd/tests/_jest/helpers/mocks';
import http from 'http';
import nock from 'nock';
import path from 'path';
import {
    build,
    createServer,
    defaultServerConditions,
    type Plugin,
    type ViteDevServer,
} from 'vite';

const BASE = '/app/';
const CLASSIC_INLINE_SCRIPT = 'window.classicInlineRan = true;';
const AUTHORED_INLINE_MODULE = 'window.authoredModuleRan = true;';

// Injects the preamble the way @vitejs/plugin-react does: a normal-order hook, after Vite's own.
const reactPreamblePlugin = (): Plugin => {
    let base = '/';
    return {
        name: 'test-react-preamble',
        configResolved(config) {
            base = config.base;
        },
        transformIndexHtml: () => [
            { tag: 'script', attrs: { type: 'module' }, children: getPreamble(base) },
        ],
    };
};

const writeApp = (root: string) => {
    const html = [
        '<!doctype html><html><head>',
        `<script>${CLASSIC_INLINE_SCRIPT}</script>`,
        `<script type="module">${AUTHORED_INLINE_MODULE}</script>`,
        '</head><body><script type="module" src="./main.js"></script></body></html>',
    ].join('\n');
    const files: Array<[string, string]> = [
        ['index.html', html],
        ['main.js', 'export {};\n'],
        ['public/static.html', '<p>static</p>\n'],
    ];
    for (const [file, content] of files) {
        const filePath = path.join(root, file);
        outputFileSync(filePath, content);
    }
};

const createAppsPlugin = (root: string): Plugin => ({
    name: 'dd-apps-test',
    enforce: 'post',
    ...getVitePlugin({
        bundler: { build, defaultServerConditions },
        context: getContextMock({ buildRoot: root }),
        options: {
            include: [],
            tags: [],
            longPolling: {
                maxRetries: 1,
                timeoutMs: 1000,
                jitter: false,
                exponentialBackoff: false,
            },
        },
    }),
});

const startDevServer = async (root: string) => {
    const appsPlugin = createAppsPlugin(root);
    const server = await createServer({
        configFile: false,
        root,
        base: BASE,
        logLevel: 'silent',
        server: { host: '127.0.0.1', port: 0 },
        plugins: [reactPreamblePlugin(), appsPlugin],
        optimizeDeps: { noDiscovery: true },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') {
        throw new Error('Expected the dev server to listen on a TCP port');
    }
    return { server, port: address.port };
};

const getFrom = (port: number, urlPath: string) =>
    httpGet(port, urlPath, { host: `localhost:${port}` });

beforeAll(() => {
    nock.enableNetConnect('127.0.0.1');
});

afterAll(() => {
    nock.disableNetConnect();
});

describe('Dev server app CSP — real Vite dev server', () => {
    let root: string;
    let server: ViteDevServer;
    let port: number;
    let restoreEnv: () => void;

    const get = (urlPath: string) => getFrom(port, urlPath);

    beforeAll(async () => {
        // Without credentials, configureServer skips the backend function sandbox setup.
        restoreEnv = clearDatadogEnv();
        root = getTempWorkingDir(`apps-csp-${Date.now()}`);
        writeApp(root);
        ({ server, port } = await startDevServer(root));
    }, 30000);

    afterAll(async () => {
        await server?.close();
        rmSync(root);
        restoreEnv();
    });

    test('Should allow the injected preamble by the hash of its served text, and nothing else inline', async () => {
        const { headers, body } = await get(BASE);
        const policy = String(headers[APP_CSP_HEADER.toLowerCase()]);
        const preamble = getPreamble(BASE);

        expect(body).toContain(preamble);
        expect(body).toContain(CLASSIC_INLINE_SCRIPT);
        // Vite serves an authored inline module from a URL, which 'self' allows.
        expect(body).not.toContain(AUTHORED_INLINE_MODULE);
        const preambleHash = sha256Source(preamble);
        expect(getDirective(policy, 'script-src')).toEqual([
            ...getAppCspDirective('script-src'),
            preambleHash,
        ]);
    });

    test('Should allow the HMR WebSocket and leave out frame-ancestors', async () => {
        const { headers } = await get(BASE);
        const policy = String(headers[APP_CSP_HEADER.toLowerCase()]);

        const appSources = getAppCspDirective('connect-src');
        const connectSources = getDirective(policy, 'connect-src');

        expect(connectSources.slice(0, appSources.length)).toEqual(appSources);
        expect(connectSources).toContain(`ws://localhost:${port}`);
        expect(getDirective(policy, 'frame-ancestors')).toEqual([]);
    });

    test('Should apply the CSP to HTML served from the public directory', async () => {
        const { headers } = await get(`${BASE}static.html`);
        const policy = String(headers[APP_CSP_HEADER.toLowerCase()]);

        expect(getDirective(policy, 'script-src')).toEqual(getAppCspDirective('script-src'));
    });

    test('Should load the violation logger first, from a URL the policy allows', async () => {
        const { body } = await get(BASE);
        const loggerTag = new RegExp(`<script src="(${BASE}[^"]*${CSP_VIOLATION_LOGGER_ID})">`);
        const [tag, src] = body.match(loggerTag) ?? [];

        if (!tag || !src) {
            throw new Error('Expected the page to load the violation logger');
        }
        expect(body.indexOf(tag)).toBeLessThan(body.indexOf(CLASSIC_INLINE_SCRIPT));
        const logger = await get(src);
        expect(logger.headers['content-type']).toContain('javascript');
        expect(logger.body).toContain('securitypolicyviolation');
    });

    test('Should leave the Vite client script alone', async () => {
        const { headers } = await get(`${BASE}@vite/client`);

        expect(headers[APP_CSP_HEADER.toLowerCase()]).toBeUndefined();
    });
});

describe('Dev server app CSP — under Vitest', () => {
    let root: string;
    let server: ViteDevServer;
    let port: number;
    let restoreEnv: () => void;

    beforeAll(async () => {
        restoreEnv = clearDatadogEnv();
        root = getTempWorkingDir(`apps-csp-vitest-${Date.now()}`);
        writeApp(root);
        // Vitest sets VITEST and serves its own UI and browser-mode pages from this server.
        process.env.VITEST = 'true';
        try {
            ({ server, port } = await startDevServer(root));
        } finally {
            delete process.env.VITEST;
        }
    }, 30000);

    afterAll(async () => {
        await server?.close();
        rmSync(root);
        restoreEnv();
    });

    test('Should send pages without the app CSP or the violation logger', async () => {
        const { headers, body } = await getFrom(port, BASE);

        expect(headers[APP_CSP_HEADER.toLowerCase()]).toBeUndefined();
        expect(body).not.toContain(CSP_VIOLATION_LOGGER_ID);
    });
});

describe('Dev server app CSP — middleware mode, by app type', () => {
    const HOST_PAGE = '<html><head></head><body>host page</body></html>';
    const cases: {
        description: string;
        appType: typeof SELF_SERVED_APP_TYPE | undefined;
        hasPolicy: boolean;
    }[] = [
        {
            description: 'send no app CSP when the host serves its own HTML',
            appType: SELF_SERVED_APP_TYPE,
            hasPolicy: false,
        },
        {
            description: 'send the app CSP for the default app type',
            appType: undefined,
            hasPolicy: true,
        },
    ];

    test.each(cases)(
        'Should $description',
        async ({ appType, hasPolicy }) => {
            const restoreEnv = clearDatadogEnv();
            const root = getTempWorkingDir(`apps-csp-app-type-${Date.now()}`);
            writeApp(root);
            const vite = await createServer({
                configFile: false,
                root,
                appType,
                logLevel: 'silent',
                server: { middlewareMode: true, hmr: false },
                plugins: [createAppsPlugin(root)],
                optimizeDeps: { noDiscovery: true },
            });
            const host = http.createServer((req, res) => {
                vite.middlewares(req, res, () => {
                    res.setHeader('Content-Type', 'text/html');
                    res.end(HOST_PAGE);
                });
            });
            try {
                await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
                const address = host.address();
                if (!address || typeof address === 'string') {
                    throw new Error('Expected the host server to listen on a TCP port');
                }
                const { headers } = await getFrom(address.port, '/host-page');

                expect(headers[APP_CSP_HEADER.toLowerCase()] !== undefined).toBe(hasPolicy);
            } finally {
                await new Promise((resolve) => host.close(resolve));
                await vite.close();
                rmSync(root);
                restoreEnv();
            }
        },
        30000,
    );
});
