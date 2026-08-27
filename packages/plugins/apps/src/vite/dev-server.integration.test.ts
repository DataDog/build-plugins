// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Real coverage for the local-execution path's module resolution: no mocked
 * `viteBuild`/`loadModule`, no hand-written stand-in module. This spins up
 * a real Vite dev server (`createServer`, middleware mode — no port bound)
 * rooted at the same `apps_backend_project` fixture `backend/integration.test.ts`
 * uses, and lets its real `ssrLoadModule` import a real `.backend.ts` file
 * directly and execute it via the real `/__dd/executeAction` HTTP handler,
 * including resolving `@datadog/apps-backend` from the fixture's own project
 * root rather than build-plugins' own dependency tree.
 *
 * Does NOT register `getVitePlugin()`'s own transform hook on this server —
 * `createServer` here has no `plugins:` array — so this does not exercise
 * `vite/index.ts`'s `.backend.ts` → RPC-proxy transform or its interaction
 * with `LOCAL_EXECUTION_LOAD_SUFFIX`; `index.test.ts` covers that hook
 * directly instead. Registering the real plugin here (so this test also
 * catches a regression in the plugin's own filter/handler wiring, not just
 * the handler function in isolation) is a valuable, real follow-up.
 *
 * Uses `@datadog/apps-backend` (the fixture already has it as a real,
 * locally-resolvable dependency — see `packages/tests/src/_jest/fixtures/
 * node_modules/@datadog/apps-backend`) rather than `@datadog/action-catalog`
 * (no equivalent local fixture package exists yet for it).
 * `local-execution.test.ts` already separately proves a raw
 * `$.Actions.foo.bar(...)` call and an action-catalog typed-wrapper call —
 * which reduce to the same injected `executeAction` under the hood — route
 * correctly. Building a real local `@datadog/action-catalog` fixture package
 * is a reasonable, cheap follow-up, not required for this coverage to be
 * meaningful.
 */

import { createDevServerMiddleware } from '@dd/apps-plugin/vite/dev-server';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import { build, createServer, type ViteDevServer } from 'vite';

import { encodeQueryName } from '../backend/encodeQueryName';
import type { BackendFunction } from '../backend/types';

const FIXTURE_ROOT = path.resolve(
    __dirname,
    '../../../../tests/src/_jest/fixtures/apps_backend_project',
);

const getRuntimeUsersFunc: BackendFunction = {
    relativePath: 'getRuntimeUsers',
    name: 'getRuntimeUsers',
    absolutePath: path.join(FIXTURE_ROOT, 'getRuntimeUsers.backend.ts'),
    allowedConnectionIds: [],
};

function createMockRequest(url: string, body: Record<string, unknown>): IncomingMessage {
    const req = new EventEmitter() as unknown as IncomingMessage;
    req.method = 'POST';
    req.url = url;
    process.nextTick(() => {
        (req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)));
        (req as unknown as EventEmitter).emit('end');
    });
    return req;
}

function createMockResponse() {
    let body = '';
    let resolveDone: () => void;
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    const res = {
        statusCode: 200,
        setHeader: jest.fn(),
        end: jest.fn((data: string) => {
            body = data || '';
            resolveDone();
        }),
        getBody() {
            return body;
        },
        done,
    };
    return res as typeof res & ServerResponse;
}

describe('Dev Server Middleware — real end-to-end local execution', () => {
    let server: ViteDevServer;

    beforeAll(async () => {
        server = await createServer({
            configFile: false,
            root: FIXTURE_ROOT,
            logLevel: 'silent',
            server: { middlewareMode: true, hmr: false },
            ssr: { noExternal: true },
        });
    });

    afterAll(async () => {
        await server.close();
    });

    test('Should import a real backend function directly via the real Vite dev server and execute it locally, with a real @datadog/apps-backend typed import resolving $.Source correctly', async () => {
        const middleware = createDevServerMiddleware(
            build,
            server.ssrLoadModule.bind(server),
            () => [getRuntimeUsersFunc],
            { site: 'datadoghq.com' },
            undefined, // no auth configured — this function never calls $.Actions
            FIXTURE_ROOT,
            getMockLogger(),
        );

        const req = createMockRequest('/__dd/executeAction', {
            functionName: encodeQueryName(getRuntimeUsersFunc),
            args: ['e2e-test'],
        });
        const res = createMockResponse();

        middleware(req, res, jest.fn());
        await res.done;

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.getBody());
        expect(body.success).toBe(true);
        expect(body.result).toEqual({
            data: {
                label: 'e2e-test',
                executionUser: { id: 'local-dev', orgId: 'local-dev-org' },
                initiatingUser: { id: 'local-dev', orgId: 'local-dev-org' },
            },
        });
    }, 30000);
});
