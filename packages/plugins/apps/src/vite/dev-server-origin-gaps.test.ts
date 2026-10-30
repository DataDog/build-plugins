// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { CspServerConfig } from '@dd/apps-plugin/vite/dev-server-csp';
import {
    createOriginGapMiddleware,
    DEV_SERVER_ROUTE_PREFIX,
    formatProxyWarning,
    getNonGetWarning,
    getProxyWarning,
    getSameOriginFrameWarning,
    MAX_WARNED_ORIGIN_GAPS,
    ORIGIN_GAP_WARNINGS_CAPPED_MESSAGE,
} from '@dd/apps-plugin/vite/dev-server-origin-gaps';
import { DEV_SERVER_ROUTES } from '@dd/apps-plugin/vite/dev-server';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import type { IncomingHttpHeaders } from 'http';
import http from 'http';
import net from 'net';

type RequestShape = { method: string; url: string; headers?: IncomingHttpHeaders };

const SAME_ORIGIN_FRAME = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' };
const baseConfig: CspServerConfig = { server: {} };

const createRequest = ({ method, url, headers = {} }: RequestShape) => {
    const req = new http.IncomingMessage(new net.Socket());
    req.method = method;
    req.url = url;
    req.headers = headers;
    return req;
};

const runRequests = (requests: RequestShape[], config: CspServerConfig = baseConfig) => {
    const warn = jest.fn();
    const debug = jest.fn();
    const next = jest.fn();
    const logger = getMockLogger({ warn, debug });
    const middleware = createOriginGapMiddleware(config, logger);
    for (const request of requests) {
        const req = createRequest(request);
        const res = new http.ServerResponse(req);
        middleware(req, res, next);
    }
    const warnings = warn.mock.calls.map(([message]) => message);
    return { warnings, debug, next };
};

describe('Dev server origin gaps — createOriginGapMiddleware', () => {
    const cases: { description: string; request: RequestShape; expected: string[] }[] = [
        {
            description: 'warn about an iframe of a page on its own origin',
            request: { method: 'GET', url: '/app/inner.html', headers: SAME_ORIGIN_FRAME },
            expected: [getSameOriginFrameWarning('/app/inner.html')],
        },
        {
            description: 'warn about a frame of a page on its own origin',
            request: {
                method: 'GET',
                url: '/inner.html',
                headers: { 'sec-fetch-dest': 'frame', 'sec-fetch-site': 'same-origin' },
            },
            expected: [getSameOriginFrameWarning('/inner.html')],
        },
        {
            description: 'leave a frame loaded by another site alone',
            request: {
                method: 'GET',
                url: '/inner.html',
                headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' },
            },
            expected: [],
        },
        {
            description: 'leave a same-origin page navigation alone',
            request: {
                method: 'GET',
                url: '/next.html',
                headers: { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' },
            },
            expected: [],
        },
        {
            description: 'warn about a form post to the dev server',
            request: { method: 'POST', url: '/submit' },
            expected: [getNonGetWarning('POST', '/submit')],
        },
        {
            description: 'warn about a request the page sends to its own origin',
            request: {
                method: 'POST',
                url: '/submit',
                headers: { 'sec-fetch-site': 'same-origin' },
            },
            expected: [getNonGetWarning('POST', '/submit')],
        },
        {
            description: 'leave a request from another site alone',
            request: {
                method: 'POST',
                url: '/submit',
                headers: { 'sec-fetch-site': 'cross-site' },
            },
            expected: [],
        },
        {
            description: 'leave a request from another origin on the same site alone',
            request: { method: 'POST', url: '/submit', headers: { 'sec-fetch-site': 'same-site' } },
            expected: [],
        },
        {
            description: 'leave a CORS preflight alone',
            request: { method: 'OPTIONS', url: '/submit' },
            expected: [],
        },
        {
            description: 'report both gaps for a form posted into a frame on its own origin',
            request: { method: 'POST', url: '/inner.html', headers: SAME_ORIGIN_FRAME },
            expected: [
                getSameOriginFrameWarning('/inner.html'),
                getNonGetWarning('POST', '/inner.html'),
            ],
        },
        {
            description: 'name the path without its query string',
            request: { method: 'PUT', url: '/api/items/1?draft=true' },
            expected: [getNonGetWarning('PUT', '/api/items/1')],
        },
        {
            description: 'warn about a HEAD request, which an uploaded app also refuses',
            request: { method: 'HEAD', url: '/main.js' },
            expected: [getNonGetWarning('HEAD', '/main.js')],
        },
        {
            description: 'leave a GET request alone',
            request: { method: 'GET', url: '/main.js' },
            expected: [],
        },
        {
            description: 'leave a path under a /__dd/ lookalike prefix to the check',
            request: { method: 'POST', url: '/__ddx/submit' },
            expected: [getNonGetWarning('POST', '/__ddx/submit')],
        },
    ];

    test.each(DEV_SERVER_ROUTES)('Should leave the plugin route %s out of the check', (route) => {
        const { warnings } = runRequests([{ method: 'POST', url: route }]);
        const isUnderPrefix = route.startsWith(DEV_SERVER_ROUTE_PREFIX);

        expect(isUnderPrefix).toBe(true);
        expect(warnings).toEqual([]);
    });

    test.each(cases)('Should $description', ({ request, expected }) => {
        const { warnings, next } = runRequests([request]);

        expect(warnings).toEqual(expected);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('Should leave a request under server.proxy to the startup warning', () => {
        const config: CspServerConfig = { server: { proxy: { '/api': 'http://localhost:3000' } } };
        const { warnings } = runRequests([{ method: 'POST', url: '/api/items' }], config);

        expect(warnings).toEqual([]);
    });

    test('Should warn once per rule and path', () => {
        const { warnings } = runRequests([
            { method: 'POST', url: '/submit' },
            { method: 'POST', url: '/submit?again=1' },
            { method: 'PUT', url: '/submit' },
            { method: 'POST', url: '/other' },
            { method: 'GET', url: '/submit', headers: SAME_ORIGIN_FRAME },
            { method: 'GET', url: '/submit', headers: SAME_ORIGIN_FRAME },
        ]);

        expect(warnings).toEqual([
            getNonGetWarning('POST', '/submit'),
            getNonGetWarning('POST', '/other'),
            getSameOriginFrameWarning('/submit'),
        ]);
    });

    test('Should stop warning after the cap, so paths with IDs cannot flood the console', () => {
        const requests = Array.from({ length: MAX_WARNED_ORIGIN_GAPS + 3 }, (_, index) => ({
            method: 'POST',
            url: `/items/${index}`,
        }));
        const { warnings, debug } = runRequests([...requests, requests[0]]);
        const firstUnwarned = getNonGetWarning('POST', `/items/${MAX_WARNED_ORIGIN_GAPS}`);

        expect(warnings).toHaveLength(MAX_WARNED_ORIGIN_GAPS + 1);
        expect(warnings[MAX_WARNED_ORIGIN_GAPS]).toBe(
            `${firstUnwarned} ${ORIGIN_GAP_WARNINGS_CAPPED_MESSAGE}`,
        );
        expect(debug).toHaveBeenCalledTimes(2);
    });

    test('Should point server.proxy users at calls an uploaded app can make', () => {
        const warning = formatProxyWarning(['/api']);

        expect(warning).toContain('backend function');
        expect(warning).toContain('cross-origin');
    });

    test('Should describe the gap without naming internal components', () => {
        const messages = [
            getSameOriginFrameWarning('/inner.html'),
            getNonGetWarning('POST', '/submit'),
            formatProxyWarning(['/api']),
        ];

        for (const message of messages) {
            expect(message).toContain('uploaded app');
            expect(message).not.toMatch(/shim|sandbox/i);
        }
    });
});

describe('Dev server origin gaps — getProxyWarning', () => {
    const cases: {
        description: string;
        proxy: CspServerConfig['server']['proxy'];
        expected: string[] | undefined;
    }[] = [
        { description: 'stay silent without server.proxy', proxy: undefined, expected: undefined },
        { description: 'stay silent with an empty server.proxy', proxy: {}, expected: undefined },
        {
            description: 'name every proxied path',
            proxy: { '/api': 'http://localhost:3000', '^/auth/.*': { target: 'http://x' } },
            expected: ['/api', '^/auth/.*'],
        },
        {
            description: 'skip a key Vite ignores for having no target',
            proxy: { '/api': 'http://localhost:3000', '/unset': undefined },
            expected: ['/api'],
        },
        {
            description: 'stay silent when every key has no target',
            proxy: { '/unset': undefined },
            expected: undefined,
        },
    ];

    test.each(cases)('Should $description', ({ proxy, expected }) => {
        const config: CspServerConfig = { server: { proxy } };
        const warning = getProxyWarning(config);
        const expectedWarning = expected && formatProxyWarning(expected);

        expect(warning).toBe(expectedWarning);
    });
});
