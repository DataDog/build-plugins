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
 * The nested-import test below registers the real `getVitePlugin()` hooks
 * on this server (previous versions of this file didn't, and left that as a
 * documented follow-up) — needed specifically to exercise `resolveId`'s
 * `LOCAL_EXECUTION_LOAD_SUFFIX` propagation against Vite's own real module
 * resolution, which a mocked `this.resolve()` can't reproduce.
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
import { getVitePlugin } from '@dd/apps-plugin/vite/index';
import { getContextMock, getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import { build, createServer, type Plugin, type ViteDevServer } from 'vite';

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

const nestedImportFunc: BackendFunction = {
    relativePath: 'nestedImport',
    name: 'usesNestedImport',
    absolutePath: path.join(FIXTURE_ROOT, 'nestedImport.backend.ts'),
    allowedConnectionIds: [],
};

describe('Dev Server Middleware — real end-to-end local execution', () => {
    let server: ViteDevServer;

    beforeAll(async () => {
        const appsPlugin: Plugin = {
            name: 'dd-apps-test',
            ...getVitePlugin({
                bundler: { build },
                context: getContextMock({ buildRoot: FIXTURE_ROOT }),
                options: {
                    authOverrides: { method: 'apiKey' },
                    include: [],
                    dryRun: true,
                },
            }),
        };

        server = await createServer({
            configFile: false,
            root: FIXTURE_ROOT,
            logLevel: 'silent',
            server: { middlewareMode: true, hmr: false },
            ssr: { noExternal: true },
            plugins: [appsPlugin],
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

    // Real coverage for the resolveId propagation fix in vite/index.ts:
    // nestedImport.backend.ts statically imports plainEcho from
    // getRuntimeUsers.backend.ts. Without propagating
    // LOCAL_EXECUTION_LOAD_SUFFIX onto that nested import, Vite would
    // resolve it unsuffixed, the transform hook would replace it with the
    // frontend RPC-proxy stub (calling globalThis.DD_APPS_RUNTIME, which
    // doesn't exist server-side), and this would throw instead of returning
    // the real value.
    test('Should preserve real code for a nested *.backend.ts import, not swap it for the frontend RPC-proxy stub', async () => {
        const middleware = createDevServerMiddleware(
            build,
            server.ssrLoadModule.bind(server),
            () => [nestedImportFunc],
            { site: 'datadoghq.com' },
            undefined,
            FIXTURE_ROOT,
            getMockLogger(),
        );

        const req = createMockRequest('/__dd/executeAction', {
            functionName: encodeQueryName(nestedImportFunc),
            args: ['nested-value'],
        });
        const res = createMockResponse();

        middleware(req, res, jest.fn());
        await res.done;

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.getBody());
        expect(body.success).toBe(true);
        expect(body.result).toEqual({ data: { value: 'nested-value' } });
    }, 30000);
});
