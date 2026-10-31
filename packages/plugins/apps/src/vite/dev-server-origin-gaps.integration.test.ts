// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { httpRequest } from '@dd/apps-plugin/vite/dev-server-csp.fixtures';
import {
    formatProxyWarning,
    getNonGetWarning,
    getSameOriginFrameWarning,
} from '@dd/apps-plugin/vite/dev-server-origin-gaps';
import { getVitePlugin } from '@dd/apps-plugin/vite/index';
import { outputFileSync, rmSync } from '@dd/core/helpers/fs';
import { clearDatadogEnv } from '@dd/tests/_jest/helpers/datadogEnv';
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import { getContextMock, getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import nock from 'nock';
import path from 'path';
import { build, createServer, defaultServerConditions, type ViteDevServer } from 'vite';

const PROXIED_PATH = '/api';
// The discard port refuses connections, so a proxied request fails fast without leaving the host.
const PROXY_TARGET = 'http://127.0.0.1:9';
const SAME_ORIGIN_FRAME = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' };

const writeApp = (root: string) => {
    const files: Array<[string, string]> = [
        [
            'index.html',
            '<!doctype html><html><body><iframe src="./inner.html"></iframe></body></html>',
        ],
        ['inner.html', '<!doctype html><html><body>inner</body></html>'],
    ];
    for (const [file, content] of files) {
        outputFileSync(path.join(root, file), content);
    }
};

const startDevServer = async (root: string, warn: jest.Mock) => {
    const logger = getMockLogger({ warn });
    const getLogger = jest.fn(() => logger);
    const context = getContextMock({ buildRoot: root, getLogger });
    const appsPlugin = getVitePlugin({
        bundler: { build, defaultServerConditions },
        context,
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
    });
    const server = await createServer({
        configFile: false,
        root,
        logLevel: 'silent',
        server: { host: '127.0.0.1', port: 0, proxy: { [PROXIED_PATH]: PROXY_TARGET } },
        plugins: [{ name: 'dd-apps-test', enforce: 'post', ...appsPlugin }],
        optimizeDeps: { noDiscovery: true },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') {
        throw new Error('Expected the dev server to listen on a TCP port');
    }
    return { server, port: address.port };
};

beforeAll(() => {
    nock.enableNetConnect('127.0.0.1');
});

afterAll(() => {
    nock.disableNetConnect();
});

describe('Dev server origin gaps — real Vite dev server', () => {
    const warn = jest.fn();
    let root: string;
    let server: ViteDevServer;
    let port: number;
    let restoreEnv: () => void;
    // clearMocks empties warn before each test, so keep what startup logged.
    let startupWarnings: unknown[] = [];

    const send = (method: string, urlPath: string, headers = {}) =>
        httpRequest(port, method, urlPath, { host: `localhost:${port}`, ...headers });
    const getWarnings = () => warn.mock.calls.map(([message]) => message);

    beforeAll(async () => {
        restoreEnv = clearDatadogEnv();
        root = getTempWorkingDir(`apps-origin-gaps-${Date.now()}`);
        writeApp(root);
        ({ server, port } = await startDevServer(root, warn));
        startupWarnings = warn.mock.calls.map(([message]) => message);
    }, 30000);

    afterAll(async () => {
        await server?.close();
        rmSync(root);
        restoreEnv();
    });

    test('Should warn once at startup that server.proxy paths work only on the dev server', () => {
        const proxyWarning = formatProxyWarning([PROXIED_PATH]);
        const proxyWarnings = startupWarnings.filter((message) => message === proxyWarning);

        expect(proxyWarnings).toHaveLength(1);
    });

    test('Should warn once about a page framed by its own origin, and still serve it', async () => {
        const first = await send('GET', '/inner.html', SAME_ORIGIN_FRAME);
        await send('GET', '/inner.html', SAME_ORIGIN_FRAME);
        const frameWarning = getSameOriginFrameWarning('/inner.html');
        const frameWarnings = getWarnings().filter((message) => message === frameWarning);

        expect(first.status).toBe(200);
        expect(frameWarnings).toHaveLength(1);
    });

    test('Should warn about a form post to the dev server', async () => {
        await send('POST', '/submit?step=1');
        const warnings = getWarnings();
        const postWarning = getNonGetWarning('POST', '/submit');

        expect(warnings).toContain(postWarning);
    });

    test("Should leave the plugin's own routes and proxied paths out of the request warnings", async () => {
        await send('POST', '/__dd/executeAction', { 'content-type': 'application/json' });
        await send('POST', `${PROXIED_PATH}/items`);
        const warnings = getWarnings();
        const routeWarning = getNonGetWarning('POST', '/__dd/executeAction');
        const proxiedWarning = getNonGetWarning('POST', `${PROXIED_PATH}/items`);

        expect(warnings).not.toContain(routeWarning);
        expect(warnings).not.toContain(proxiedWarning);
    });
});

describe('Dev server origin gaps — under Vitest', () => {
    test('Should log no origin-gap warnings when the app CSP is off', async () => {
        const warn = jest.fn();
        const restoreEnv = clearDatadogEnv();
        const root = getTempWorkingDir(`apps-origin-gaps-vitest-${Date.now()}`);
        writeApp(root);
        process.env.VITEST = 'true';
        let server: ViteDevServer | undefined;
        try {
            const started = await startDevServer(root, warn);
            server = started.server;
            await httpRequest(started.port, 'POST', '/submit', {
                host: `localhost:${started.port}`,
            });
        } finally {
            delete process.env.VITEST;
            await server?.close();
            rmSync(root);
            restoreEnv();
        }
        const warnings = warn.mock.calls.map(([message]) => message);
        const proxyWarning = formatProxyWarning([PROXIED_PATH]);
        const postWarning = getNonGetWarning('POST', '/submit');

        expect(warnings).not.toContain(proxyWarning);
        expect(warnings).not.toContain(postWarning);
    }, 30000);
});
