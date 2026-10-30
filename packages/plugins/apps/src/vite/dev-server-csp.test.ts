// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { APP_CSP_DIRECTIVES } from '@dd/apps-plugin/vite/app-csp';
import {
    getAppCspDirective,
    getDirective,
    httpGet,
} from '@dd/apps-plugin/vite/dev-server-csp.fixtures';
import type { HttpGetResponse } from '@dd/apps-plugin/vite/dev-server-csp.fixtures';
import type { CspServerConfig } from '@dd/apps-plugin/vite/dev-server-csp';
import {
    APP_CSP_HEADER,
    createAppCspMiddleware,
    getHmrWebSocketSources,
    MIDDLEWARE_MODE_HMR_PORT,
} from '@dd/apps-plugin/vite/dev-server-csp';
import http from 'http';
import net from 'net';
import nock from 'nock';

const CLASSIC_INLINE_SCRIPT = 'window.inlineRan = true;';
// The React Refresh preamble @vitejs/plugin-react injects.
const INLINE_MODULE_SCRIPT = [
    'import { injectIntoGlobalHook } from "/@react-refresh";',
    'injectIntoGlobalHook(window);',
    'window.$RefreshReg$ = () => {};',
    'window.$RefreshSig$ = () => (type) => type;',
].join('\n');
const SERVER_PORT = 5173;
const ENFORCED_CSP_HEADER = 'Content-Security-Policy';

const baseConfig: CspServerConfig = {
    server: { hmr: true, middlewareMode: false, port: SERVER_PORT },
};

describe('app-csp — APP_CSP_DIRECTIVES', () => {
    test('Should leave out frame-ancestors, which only applies to a framed document', () => {
        expect(APP_CSP_DIRECTIVES.map(([name]) => name)).not.toContain('frame-ancestors');
    });

    const blockedCases: { description: string; directive: string; forbidden: string[] }[] = [
        {
            description: 'block data: and http: scripts',
            directive: 'script-src',
            forbidden: ['data:', 'http:', '*'],
        },
        {
            description: 'block data: and http: styles',
            directive: 'style-src',
            forbidden: ['data:', 'http:', '*'],
        },
        {
            description: 'block http: and ws: requests',
            directive: 'connect-src',
            forbidden: ['http:', 'ws:', 'wss:', '*'],
        },
        { description: 'block http: images', directive: 'img-src', forbidden: ['http:', '*'] },
        {
            description: 'block data: and https: workers',
            directive: 'worker-src',
            forbidden: ['data:', 'https:', '*'],
        },
        {
            description: 'block data: and http: frames',
            directive: 'frame-src',
            forbidden: ['data:', 'http:', '*'],
        },
        {
            description: 'block a <base> to another origin',
            directive: 'base-uri',
            forbidden: ['https:', '*'],
        },
        {
            description: 'block http: form posts',
            directive: 'form-action',
            forbidden: ['http:', '*'],
        },
    ];

    test.each(blockedCases)('Should $description', ({ directive, forbidden }) => {
        const sources = getAppCspDirective(directive);
        expect(sources.length).toBeGreaterThan(0);
        for (const source of forbidden) {
            expect(sources).not.toContain(source);
        }
    });

    const allowedCases: { description: string; directive: string; required: string[] }[] = [
        {
            description: 'allow inline scripts, eval and https: scripts',
            directive: 'script-src',
            required: ["'unsafe-inline'", "'unsafe-eval'", 'https:', 'blob:'],
        },
        { description: 'allow https: images', directive: 'img-src', required: ['https:'] },
        { description: 'allow blob: workers', directive: 'worker-src', required: ['blob:'] },
        { description: 'allow https: frames', directive: 'frame-src', required: ['https:'] },
        { description: 'allow https: form posts', directive: 'form-action', required: ['https:'] },
    ];

    test.each(allowedCases)(
        'Should $description, as production does',
        ({ directive, required }) => {
            expect(getAppCspDirective(directive)).toEqual(expect.arrayContaining(required));
        },
    );

    test.each(['object-src', 'manifest-src'])('Should block all %s content', (directive) => {
        expect(getAppCspDirective(directive)).toEqual(["'none'"]);
    });
});

describe('dev-server-csp — getHmrWebSocketSources', () => {
    const cases: {
        description: string;
        config: CspServerConfig;
        host: string | undefined;
        encrypted?: boolean;
        expected: string[];
    }[] = [
        {
            description: "allow the page's own host and the direct fallback",
            config: baseConfig,
            host: `127.0.0.1:${SERVER_PORT}`,
            expected: [`ws://127.0.0.1:${SERVER_PORT}`, `ws://localhost:${SERVER_PORT}`],
        },
        {
            description: 'use wss for an https page',
            config: { server: { ...baseConfig.server, https: {} } },
            host: `localhost:${SERVER_PORT}`,
            expected: [`wss://localhost:${SERVER_PORT}`],
        },
        {
            description: 'use wss for a page served over TLS',
            config: baseConfig,
            host: `localhost:${SERVER_PORT}`,
            encrypted: true,
            expected: [`wss://localhost:${SERVER_PORT}`],
        },
        {
            description: 'use the HMR host, port and protocol from the config',
            config: {
                server: {
                    ...baseConfig.server,
                    hmr: { host: 'hmr.localhost', port: 24680, protocol: 'wss' },
                },
            },
            host: `localhost:${SERVER_PORT}`,
            expected: ['wss://hmr.localhost:24680'],
        },
        {
            description: 'prefer the HMR client port for the page connection',
            config: { server: { ...baseConfig.server, hmr: { clientPort: 443, port: 24680 } } },
            host: `app.localhost:${SERVER_PORT}`,
            expected: ['ws://app.localhost:443'],
        },
        {
            description: 'read server.ws before server.hmr',
            config: {
                server: { ...baseConfig.server, hmr: { port: 1111 }, ws: { port: 2222 } },
            },
            host: `localhost:${SERVER_PORT}`,
            expected: ['ws://localhost:2222'],
        },
        {
            description: 'use the default HMR port in middleware mode',
            config: { server: { ...baseConfig.server, middlewareMode: true } },
            host: 'localhost:3000',
            expected: [`ws://localhost:${MIDDLEWARE_MODE_HMR_PORT}`],
        },
        {
            description: 'use the configured server host for the direct fallback',
            config: { server: { ...baseConfig.server, host: '127.0.0.1' } },
            host: `localhost:${SERVER_PORT}`,
            expected: [`ws://localhost:${SERVER_PORT}`, `ws://127.0.0.1:${SERVER_PORT}`],
        },
        {
            description: 'leave an IPv6 page host to self, since a CSP source cannot name it',
            config: baseConfig,
            host: `[::1]:${SERVER_PORT}`,
            expected: [`ws://localhost:${SERVER_PORT}`],
        },
        {
            description:
                'leave a host name with an underscore to self, since a CSP source cannot name it',
            config: baseConfig,
            host: `web_app:${SERVER_PORT}`,
            expected: [`ws://localhost:${SERVER_PORT}`],
        },
        {
            description: 'skip a configured server host that a CSP source cannot name',
            config: { server: { ...baseConfig.server, host: '::1' } },
            host: `localhost:${SERVER_PORT}`,
            expected: [`ws://localhost:${SERVER_PORT}`],
        },
        {
            description: 'skip a Host header that is not a plain host and port',
            config: baseConfig,
            host: `localhost:${SERVER_PORT}; script-src 'unsafe-inline'`,
            expected: [`ws://localhost:${SERVER_PORT}`],
        },
        {
            description: 'skip a Host header that would add a policy',
            config: baseConfig,
            host: `localhost,evil.example:${SERVER_PORT}`,
            expected: [`ws://localhost:${SERVER_PORT}`],
        },
        {
            description: 'skip a Host header with an out-of-range port',
            config: baseConfig,
            host: 'localhost:99999',
            expected: [`ws://localhost:${SERVER_PORT}`],
        },
        {
            description: 'skip a missing Host header',
            config: baseConfig,
            host: undefined,
            expected: [`ws://localhost:${SERVER_PORT}`],
        },
        {
            description: 'keep the socket when only HMR is off, as the client still connects',
            config: { server: { ...baseConfig.server, hmr: false } },
            host: `localhost:${SERVER_PORT}`,
            expected: [`ws://localhost:${SERVER_PORT}`],
        },
        {
            description: 'use the default port in middleware mode with HMR off',
            config: { server: { ...baseConfig.server, hmr: false, middlewareMode: true } },
            host: 'localhost:3000',
            expected: [`ws://localhost:${MIDDLEWARE_MODE_HMR_PORT}`],
        },
        {
            description: 'allow nothing when the WebSocket server is off',
            config: { server: { ...baseConfig.server, ws: false } },
            host: `localhost:${SERVER_PORT}`,
            expected: [],
        },
    ];

    test.each(cases)('Should $description', ({ config, host, encrypted, expected }) => {
        expect(getHmrWebSocketSources(config, host, encrypted ?? false)).toEqual(expected);
    });
});

describe('dev-server-csp — createAppCspMiddleware', () => {
    test('Should pass a response without the Node header API through untouched', () => {
        const req = new http.IncomingMessage(new net.Socket());
        const res = new http.ServerResponse(req);
        Reflect.set(res, 'getHeader', undefined);
        const { end } = res;
        const next = jest.fn();

        createAppCspMiddleware(baseConfig)(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.end).toBe(end);
    });
});

describe('dev-server-csp — createAppCspMiddleware over real HTTP', () => {
    type Responder = (req: http.IncomingMessage, res: http.ServerResponse) => void;
    let server: http.Server;
    let port: number;
    let respond: Responder;

    const html = `<html><head><script type="module">${INLINE_MODULE_SCRIPT}</script><script>${CLASSIC_INLINE_SCRIPT}</script></head></html>`;

    const get = (headers: Record<string, string> = {}, urlPath = '/') =>
        httpGet(port, urlPath, headers);

    const getPolicies = (res: HttpGetResponse): string[] => {
        const header = res.headers[APP_CSP_HEADER.toLowerCase()];
        if (header === undefined) {
            return [];
        }
        return [header].flat();
    };

    beforeAll(async () => {
        const middleware = createAppCspMiddleware({
            server: {
                ...baseConfig.server,
                proxy: {
                    '/api': 'http://127.0.0.1:1',
                    '^/re/.*': {},
                    '/unset': undefined,
                },
            },
        });
        server = http.createServer((req, res) => {
            middleware(req, res, () => respond(req, res));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Expected the test server to listen on a TCP port');
        }
        port = address.port;
        nock.enableNetConnect(`127.0.0.1:${port}`);
    });

    afterAll(async () => {
        nock.disableNetConnect();
        await new Promise((resolve) => server.close(resolve));
    });

    // A hash or nonce in script-src would make browsers ignore 'unsafe-inline', which production allows.
    test('Should add no script hash to a buffered HTML response with inline scripts', async () => {
        respond = (req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(html);
        };
        const served = await get();
        const [policy, ...others] = getPolicies(served);

        expect(others).toEqual([]);
        expect(getDirective(policy, 'script-src')).toEqual(getAppCspDirective('script-src'));
        expect(getDirective(policy, 'frame-ancestors')).toEqual([]);
    });

    test('Should allow the HMR WebSocket in connect-src', async () => {
        respond = (req, res) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(Buffer.from(html));
        };
        const served = await get({ host: `localhost:${port}` });
        const [policy] = getPolicies(served);

        expect(getDirective(policy, 'connect-src')).toEqual([
            ...getAppCspDirective('connect-src'),
            ...getHmrWebSocketSources(baseConfig, `localhost:${port}`, false),
        ]);
    });

    test.each(['frame-src', 'form-action'])(
        'Should allow same-origin URLs in %s on an http: dev server',
        async (directive) => {
            respond = (req, res) => {
                res.setHeader('Content-Type', 'text/html');
                res.end(html);
            };
            const served = await get();
            const [policy] = getPolicies(served);

            expect(getDirective(policy, directive)).toEqual([
                ...getAppCspDirective(directive),
                "'self'",
            ]);
        },
    );

    test('Should keep every other directive of the app CSP unchanged', async () => {
        respond = (req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(html);
        };
        const served = await get();
        const [policy] = getPolicies(served);

        for (const [name, sources] of APP_CSP_DIRECTIVES) {
            if (['script-src', 'connect-src', 'frame-src', 'form-action'].includes(name)) {
                continue;
            }
            expect(getDirective(policy, name)).toEqual(sources);
        }
    });

    test('Should apply the policy to a streamed HTML response', async () => {
        respond = (req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.write(html);
            res.end();
        };
        const served = await get();
        const [policy] = getPolicies(served);

        expect(getDirective(policy, 'script-src')).toEqual(getAppCspDirective('script-src'));
    });

    test('Should not let an existing policy replace the app CSP', async () => {
        respond = (req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.setHeader(APP_CSP_HEADER, "script-src 'unsafe-inline' 'unsafe-eval'");
            res.end(html);
        };
        const served = await get();
        const policies = getPolicies(served);

        expect(policies).toHaveLength(2);
        expect(policies[0]).toBe("script-src 'unsafe-inline' 'unsafe-eval'");
        expect(getDirective(policies[1], 'script-src')).toEqual(getAppCspDirective('script-src'));
    });

    test('Should report the app CSP without enforcing it, leaving an enforced policy alone', async () => {
        respond = (req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.setHeader(ENFORCED_CSP_HEADER, "img-src 'self'");
            res.end(html);
        };
        const served = await get();
        const [policy, ...others] = getPolicies(served);

        expect(served.headers[ENFORCED_CSP_HEADER.toLowerCase()]).toBe("img-src 'self'");
        expect(others).toEqual([]);
        expect(getDirective(policy, 'script-src')).toEqual(getAppCspDirective('script-src'));
    });

    test('Should add the policy beside one passed to writeHead, before any body is sent', async () => {
        respond = (req, res) => {
            res.writeHead(200, 'OK', {
                'content-type': 'text/html',
                [APP_CSP_HEADER]: "script-src 'unsafe-inline'",
            });
            res.end(html);
        };
        const served = await get();
        const policies = getPolicies(served);

        expect(policies).toHaveLength(2);
        expect(policies[0]).toBe("script-src 'unsafe-inline'");
        expect(getDirective(policies[1], 'script-src')).toEqual(getAppCspDirective('script-src'));
    });

    test('Should apply the policy under a proxy key Vite skips for having no target', async () => {
        respond = (req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(html);
        };
        const served = await get({}, '/unset/page');
        const [policy] = getPolicies(served);

        expect(getDirective(policy, 'script-src')).toEqual(getAppCspDirective('script-src'));
    });

    test('Should keep a policy writeHead passes on a response it leaves alone', async () => {
        respond = (req, res) => {
            res.setHeader(APP_CSP_HEADER, "default-src 'none'");
            res.writeHead(200, {
                'content-type': 'application/json',
                [APP_CSP_HEADER]: "img-src 'self'",
            });
            res.end('{}');
        };

        const served = await get();
        expect(getPolicies(served)).toEqual(["img-src 'self'"]);
    });

    test('Should apply the policy to a worker script', async () => {
        respond = (req, res) => {
            res.setHeader('Content-Type', 'text/javascript');
            res.end('postMessage(1);');
        };
        const served = await get({ 'sec-fetch-dest': 'worker' });
        const [policy] = getPolicies(served);

        expect(getDirective(policy, 'connect-src')).toEqual(
            expect.arrayContaining(getAppCspDirective('connect-src')),
        );
        expect(getDirective(policy, 'worker-src')).toEqual(getAppCspDirective('worker-src'));
    });

    test('Should drop conditional headers from a page request, so the page is never a 304', async () => {
        let seenConditionals: unknown[] = [];
        respond = (req, res) => {
            seenConditionals = [req.headers['if-none-match'], req.headers['if-modified-since']];
            res.setHeader('Content-Type', 'text/html');
            res.end(html);
        };
        await get({
            accept: 'text/html',
            'if-none-match': 'W/"1"',
            'if-modified-since': 'Wed, 21 Oct 2026 07:28:00 GMT',
        });

        expect(seenConditionals).toEqual([undefined, undefined]);
    });

    test("Should leave Vite's own bundling-in-progress page alone, so it can reload itself", async () => {
        respond = (req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(
                '<html><head><script>globalThis.__vite_is_fallback_page__ = true</script></head></html>',
            );
        };

        const served = await get();
        expect(getPolicies(served)).toEqual([]);
    });

    test('Should not hash a compressed body it cannot read', async () => {
        respond = (req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.setHeader('Content-Encoding', 'gzip');
            res.end(html);
        };
        const served = await get();
        const [policy] = getPolicies(served);

        expect(getDirective(policy, 'script-src')).toEqual(getAppCspDirective('script-src'));
    });

    const untouchedCases: { description: string; responder: Responder; path?: string }[] = [
        {
            description: 'leave a JavaScript response alone',
            responder: (req, res) => {
                res.setHeader('Content-Type', 'text/javascript');
                res.end('export {}');
            },
        },
        {
            description: 'leave HTML under a proxied path alone',
            responder: (req, res) => {
                res.setHeader('Content-Type', 'text/html');
                res.end(html);
            },
            path: '/api/login',
        },
        {
            description: 'leave HTML under a proxied pattern alone',
            responder: (req, res) => {
                res.setHeader('Content-Type', 'text/html');
                res.end(html);
            },
            path: '/re/page',
        },
        {
            description: 'leave a 304 without a content type alone',
            responder: (req, res) => {
                res.statusCode = 304;
                res.end();
            },
        },
    ];

    test.each(untouchedCases)('Should $description', async ({ responder, path }) => {
        respond = responder;
        const response = await get({}, path);
        expect(getPolicies(response)).toEqual([]);
    });
});
