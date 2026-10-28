// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { HostCheckConfig } from '@dd/apps-plugin/vite/dev-server-request-guard';
import {
    ALLOWED_HOSTS_HINT,
    checkDevServerRequest,
    createViteHostCheck,
    getRequestHost,
    MISSING_HOST_MESSAGE,
} from '@dd/apps-plugin/vite/dev-server-request-guard';
import type { IncomingHttpHeaders } from 'http';

const PREVIEW_SUFFIX = '.preview.example';
const PREVIEW_HOST = `app-5173${PREVIEW_SUFFIX}`;

const withServer = (
    server: HostCheckConfig['server'],
    preview: HostCheckConfig['preview'] = {},
): HostCheckConfig => ({ server, preview });

describe('dev-server-request-guard — createViteHostCheck', () => {
    const cases: {
        description: string;
        config: HostCheckConfig;
        host: string;
        expected: boolean;
    }[] = [
        {
            description: 'allow localhost with a port',
            config: withServer({ allowedHosts: [] }),
            host: 'localhost:5173',
            expected: true,
        },
        {
            description: 'allow a name under .localhost',
            config: withServer({ allowedHosts: [] }),
            host: 'app.localhost:5173',
            expected: true,
        },
        {
            description: 'allow an IPv4 literal',
            config: withServer({ allowedHosts: [] }),
            host: '127.0.0.1:5173',
            expected: true,
        },
        {
            description: 'allow an IPv6 literal',
            config: withServer({ allowedHosts: [] }),
            host: '[::1]:5173',
            expected: true,
        },
        {
            description: 'reject an unterminated IPv6 literal',
            config: withServer({ allowedHosts: [] }),
            host: '[::1',
            expected: false,
        },
        {
            description: 'reject a name the config does not allow',
            config: withServer({ allowedHosts: [] }),
            host: 'attacker.example:5173',
            expected: false,
        },
        {
            description: "reject a name Vite's file: and -extension: allowance would let through",
            config: withServer({ allowedHosts: [] }),
            host: 'build-extension:5173',
            expected: false,
        },
        {
            description: 'allow an exact allowedHosts entry',
            config: withServer({ allowedHosts: ['dev.example'] }),
            host: 'dev.example:5173',
            expected: true,
        },
        {
            description: 'allow a host under a .suffix allowedHosts entry',
            config: withServer({ allowedHosts: [PREVIEW_SUFFIX] }),
            host: PREVIEW_HOST,
            expected: true,
        },
        {
            description: 'allow the bare name of a .suffix allowedHosts entry',
            config: withServer({ allowedHosts: [PREVIEW_SUFFIX] }),
            host: PREVIEW_SUFFIX.slice(1),
            expected: true,
        },
        {
            description: 'reject a name that only shares the end of a .suffix entry',
            config: withServer({ allowedHosts: [PREVIEW_SUFFIX] }),
            host: `not${PREVIEW_SUFFIX.slice(1)}`,
            expected: false,
        },
        {
            description: 'allow the configured server.host',
            config: withServer({ allowedHosts: [], host: 'devbox.internal' }),
            host: 'devbox.internal:5173',
            expected: true,
        },
        {
            description: 'allow the configured server.hmr.host',
            config: withServer({ allowedHosts: [], hmr: { host: 'hmr.internal' } }),
            host: 'hmr.internal:5173',
            expected: true,
        },
        {
            description: 'match configured server hosts exactly, never as a .suffix',
            config: withServer({ allowedHosts: [], hmr: { host: '.corp.example' } }),
            host: 'evil.corp.example:5173',
            expected: false,
        },
        {
            description: 'allow the hostname of server.origin',
            config: withServer({ allowedHosts: [], origin: 'https://assets.example:8443' }),
            host: 'assets.example',
            expected: true,
        },
        {
            description: 'allow the configured preview.host',
            config: withServer({ allowedHosts: [] }, { host: 'preview.internal' }),
            host: 'preview.internal:4173',
            expected: true,
        },
        {
            description: 'allow any host when allowedHosts is true',
            config: withServer({ allowedHosts: true }),
            host: 'attacker.example:5173',
            expected: true,
        },
        {
            description: 'allow any host when the server uses https',
            config: withServer({ allowedHosts: [], https: {} }),
            host: 'attacker.example:5173',
            expected: true,
        },
    ];

    test.each(cases)('Should $description', ({ config, host, expected }) => {
        const isHostAllowed = createViteHostCheck(config);
        const allowed = isHostAllowed(host);

        expect(allowed).toBe(expected);
    });
});

describe('dev-server-request-guard — createViteHostCheck config reads', () => {
    test('Should read the config on each request, so a later plugin can still change it', () => {
        const config = withServer({ allowedHosts: [] });
        const isHostAllowed = createViteHostCheck(config);
        config.server.allowedHosts = ['tunnel.example'];

        const allowed = isHostAllowed('tunnel.example:5173');

        expect(allowed).toBe(true);
    });
});

describe('dev-server-request-guard — createViteHostCheck untyped config', () => {
    test('Should skip non-string allowedHosts entries, as Vite does, rather than throw', () => {
        const config = withServer({ allowedHosts: [] });
        Reflect.set(config.server, 'allowedHosts', [/\.example$/, 'dev.example']);
        const isHostAllowed = createViteHostCheck(config);
        const listedAllowed = isHostAllowed('dev.example:5173');
        const unlistedAllowed = isHostAllowed('other.example:5173');

        expect(listedAllowed).toBe(true);
        expect(unlistedAllowed).toBe(false);
    });

    test('Should ignore a null server.hmr from a JS config rather than throw', () => {
        const config = withServer({ allowedHosts: [] });
        Reflect.set(config.server, 'hmr', null);
        const isHostAllowed = createViteHostCheck(config);
        const localAllowed = isHostAllowed('localhost:5173');
        const remoteAllowed = isHostAllowed('dev.example:5173');

        expect(localAllowed).toBe(true);
        expect(remoteAllowed).toBe(false);
    });

    test('Should treat a string allowedHosts from a JS config as no extra hosts', () => {
        const config = withServer({ allowedHosts: [] });
        Reflect.set(config.server, 'allowedHosts', 'all');
        const isHostAllowed = createViteHostCheck(config);
        const localAllowed = isHostAllowed('localhost:5173');
        const remoteAllowed = isHostAllowed('dev.example:5173');

        expect(localAllowed).toBe(true);
        expect(remoteAllowed).toBe(false);
    });
});

describe('dev-server-request-guard — checkDevServerRequest', () => {
    const previewConfig = withServer({ allowedHosts: [PREVIEW_SUFFIX] });
    const isHostAllowed = createViteHostCheck(previewConfig);
    const json = 'application/json';

    const cases: {
        description: string;
        headers: IncomingHttpHeaders;
        expectedStatus: number | undefined;
    }[] = [
        {
            description: 'accept a same-origin JSON request on localhost',
            headers: {
                host: 'localhost:5173',
                origin: 'http://localhost:5173',
                'content-type': json,
            },
            expectedStatus: undefined,
        },
        {
            description: 'accept a JSON content type with a charset parameter, in any case',
            headers: {
                host: '127.0.0.1:5173',
                origin: 'http://127.0.0.1:5173',
                'content-type': 'Application/JSON; charset=utf-8',
            },
            expectedStatus: undefined,
        },
        {
            description: 'accept a request with no Origin, as non-browser clients send',
            headers: { host: 'localhost:5173', 'content-type': json },
            expectedStatus: undefined,
        },
        {
            description: 'accept a preview proxy host, whose https Origin reaches Vite over http',
            headers: {
                host: PREVIEW_HOST,
                origin: `https://${PREVIEW_HOST}`,
                'content-type': json,
            },
            expectedStatus: undefined,
        },
        {
            description: "accept an Origin on its scheme's default port against a Host naming it",
            headers: {
                host: `${PREVIEW_HOST}:443`,
                origin: `https://${PREVIEW_HOST}`,
                'content-type': json,
            },
            expectedStatus: undefined,
        },
        {
            description: 'accept an HTTP/2 request, which carries :authority instead of Host',
            headers: {
                ':authority': 'localhost:5173',
                origin: 'https://localhost:5173',
                'content-type': json,
            },
            expectedStatus: undefined,
        },
        {
            description: 'reject an HTTP/2 request whose :authority Vite would not serve',
            headers: {
                ':authority': 'attacker.example:5173',
                origin: 'https://attacker.example:5173',
                'content-type': json,
            },
            expectedStatus: 403,
        },
        {
            description: 'reject a cross-site Origin',
            headers: {
                host: 'localhost:5173',
                origin: 'https://attacker.example',
                'content-type': json,
            },
            expectedStatus: 403,
        },
        {
            description: 'reject an opaque Origin',
            headers: { host: 'localhost:5173', origin: 'null', 'content-type': json },
            expectedStatus: 403,
        },
        {
            description: 'reject another port on the same host',
            headers: {
                host: 'localhost:5173',
                origin: 'http://localhost:3000',
                'content-type': json,
            },
            expectedStatus: 403,
        },
        {
            description: 'reject a sibling preview proxy host',
            headers: {
                host: PREVIEW_HOST,
                origin: `https://app-5174${PREVIEW_SUFFIX}`,
                'content-type': json,
            },
            expectedStatus: 403,
        },
        {
            description: 'reject a same-origin request under a host Vite would not serve',
            headers: {
                host: 'attacker.example:5173',
                origin: 'http://attacker.example:5173',
                'content-type': json,
            },
            expectedStatus: 403,
        },
        {
            description: 'reject a Host whose userinfo would make it parse as the Origin host',
            headers: {
                host: 'localhost:5173@attacker.example',
                origin: 'http://attacker.example',
                'content-type': json,
            },
            expectedStatus: 403,
        },
        {
            description: 'reject a percent-encoded Host that would decode to the Origin host',
            headers: {
                host: 'evil%2ecom.localhost:5173',
                origin: 'http://evil.com.localhost:5173',
                'content-type': json,
            },
            expectedStatus: 403,
        },
        {
            description: 'reject a missing Host header',
            headers: { 'content-type': json },
            expectedStatus: 403,
        },
        {
            description: 'reject text/plain',
            headers: {
                host: 'localhost:5173',
                origin: 'http://localhost:5173',
                'content-type': 'text/plain',
            },
            expectedStatus: 415,
        },
        {
            description: 'reject a form-encoded body',
            headers: {
                host: 'localhost:5173',
                'content-type': 'application/x-www-form-urlencoded',
            },
            expectedStatus: 415,
        },
        {
            description: 'reject a media type that only starts with application/json',
            headers: { host: 'localhost:5173', 'content-type': 'application/jsonp' },
            expectedStatus: 415,
        },
        {
            description: 'reject a missing Content-Type',
            headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
            expectedStatus: 415,
        },
    ];

    test.each(cases)('Should $description', ({ headers, expectedStatus }) => {
        const rejection = checkDevServerRequest(headers, isHostAllowed);

        expect(rejection?.statusCode).toBe(expectedStatus);
    });

    test('Should name a missing Host rather than suggest an allowedHosts entry', () => {
        const rejection = checkDevServerRequest({ 'content-type': json }, isHostAllowed);

        expect(rejection?.message).toBe(MISSING_HOST_MESSAGE);
    });

    test('Should name a bracketed IPv6 host whole in the rejection message', () => {
        const rejection = checkDevServerRequest(
            { host: '[fe80::zz]:5173', 'content-type': json },
            isHostAllowed,
        );

        expect(rejection?.message).toContain('"[fe80::zz]"');
    });

    test("Should escape a Host's non-ASCII characters in the rejection message", () => {
        const rejection = checkDevServerRequest(
            { host: 'evil\u009b2J\u0085.example:5173', 'content-type': json },
            isHostAllowed,
        );

        expect(rejection?.message).toContain('"evil\\u009b2J\\u0085.example"');
        expect(rejection?.message).toMatch(/^[\x20-\x7e]*$/);
    });

    test('Should end a refused-host message with the allowedHosts hint', () => {
        const rejection = checkDevServerRequest(
            { host: 'tunnel.example:5173', 'content-type': json },
            isHostAllowed,
        );

        expect(rejection?.message.split(ALLOWED_HOSTS_HINT)[1]).toBe('');
    });

    test('Should treat an empty Host header as missing, even under a "." allowedHosts entry', () => {
        const dotConfig = withServer({ allowedHosts: ['.'] });
        const allowDot = createViteHostCheck(dotConfig);
        const rejection = checkDevServerRequest({ host: '', 'content-type': json }, allowDot);

        expect(rejection?.statusCode).toBe(403);
    });

    test('Should check the Origin against the Host even when Vite skips its host check', () => {
        const allowAnyHostConfig = withServer({ allowedHosts: true });
        const allowAnyHost = createViteHostCheck(allowAnyHostConfig);
        const rejection = checkDevServerRequest(
            { host: 'localhost:5173', origin: 'https://attacker.example', 'content-type': json },
            allowAnyHost,
        );

        expect(rejection?.statusCode).toBe(403);
    });
});

describe('dev-server-request-guard — getRequestHost', () => {
    const cases: { description: string; headers: IncomingHttpHeaders; expected?: string }[] = [
        {
            description: 'read Host',
            headers: { host: 'localhost:5173' },
            expected: 'localhost:5173',
        },
        {
            description: 'read :authority from an HTTP/2 request',
            headers: { ':authority': 'localhost:5173' },
            expected: 'localhost:5173',
        },
        {
            description: 'prefer Host over :authority',
            headers: { host: 'a.localhost', ':authority': 'b.localhost' },
            expected: 'a.localhost',
        },
        { description: 'return nothing without either', headers: {}, expected: undefined },
    ];

    test.each(cases)('Should $description', ({ headers, expected }) => {
        expect(getRequestHost(headers)).toBe(expected);
    });
});
