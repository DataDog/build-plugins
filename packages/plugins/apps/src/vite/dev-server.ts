// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-await-in-loop */

import type { AuthOptionsWithDefaults, Logger } from '@dd/core/types';
import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { build } from 'vite';

import { AUTH_GUIDANCE } from '../auth';
import type { DoAuthenticatedRequest } from '../auth';
import { encodeQueryName } from '../backend/encodeQueryName';
import type { ExecuteActionRequest, ExecuteActionResponse } from '../backend/protocol';
import type { BackendFunction } from '../backend/types';
import { generateDevVirtualEntryContent } from '../backend/virtual-entry';

import { createBackendConnectionIdCollector } from './backend-connection-id-collector';
import { getBaseBackendBuildConfig } from './build-config';
import type { ExecuteAction, LoadModule } from './local-execution';
import { executeScriptLocally } from './local-execution';

interface BundleResult {
    func: BackendFunction;
    code: string;
}

type BundleFn = (func: BackendFunction) => Promise<BundleResult>;

const DEV_VIRTUAL_PREFIX = 'virtual:dd-backend-dev:';

type AuthConfig = AuthOptionsWithDefaults;

/** Shape of the `outputs` field in a Datadog app-builder query response —
 *  the API wraps a JS action's return value as `{ data: <value> }`.
 */
type BackendOutputs = { data: unknown };

/**
 * Format a BackendFunction for display in log/error messages.
 */
function formatRef(func: BackendFunction): string {
    return `${func.relativePath}/${func.name}`;
}

/**
 * Parse JSON body from an incoming request stream.
 */
function parseRequestBody(req: IncomingMessage): Promise<ExecuteActionRequest> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Bundle a backend function using Vite's build API (Rollup under the hood).
 * Uses write: false to produce an in-memory bundle with no temp files.
 */
async function bundleBackendFunction(
    viteBuild: typeof build,
    func: BackendFunction,
    projectRoot: string,
    log: Logger,
): Promise<BundleResult> {
    const displayName = formatRef(func);
    const virtualId = `${DEV_VIRTUAL_PREFIX}${displayName}`;
    const virtualContent = generateDevVirtualEntryContent(
        func.name,
        func.absolutePath,
        projectRoot,
    );
    const connectionIdCollector = createBackendConnectionIdCollector(
        func.absolutePath,
        projectRoot,
    );

    log.debug(`Bundling backend function "${displayName}" from ${func.absolutePath}`);

    const baseConfig = getBaseBackendBuildConfig(projectRoot, { [virtualId]: virtualContent }, [
        connectionIdCollector.plugin,
    ]);

    // Dev: build a single function in-memory per request so we can send the
    // bundled script to the Datadog API without writing temp files.
    // Uses a plain "virtual:" prefix instead of \0 because Rollup generates
    // empty chunks when \0-prefixed IDs are used as input entries.
    const result = await viteBuild({
        ...baseConfig,
        build: {
            ...baseConfig.build,
            write: false,
            rollupOptions: {
                ...baseConfig.build.rollupOptions,
                input: virtualId,
                output: baseConfig.build.rollupOptions.output,
            },
        },
    });

    const output = Array.isArray(result) ? result[0] : result;

    if (!('output' in output)) {
        throw new Error(`Unexpected vite.build result for "${displayName}"`);
    }

    const code = output.output[0].type === 'chunk' ? output.output[0].code : '';
    const enrichedFunc = {
        ...func,
        allowedConnectionIds: connectionIdCollector.getAllowedConnectionIds(),
    };

    log.debug(`Bundled "${displayName}" (${code.length} bytes)`);

    return { func: enrichedFunc, code };
}

/**
 * Submit a query to Datadog's app-builder `preview-async` endpoint and
 * return its receipt ID. `querySpec` is the query's own `spec` object —
 * either the `jsFunctionWithActions` wrapper (a whole script) or a single
 * real action's own `{fqn, inputs}` directly (see `executeSingleActionRemotely`
 * below) — `submitQuery` itself doesn't care which.
 */
async function submitQuery(
    querySpec: Record<string, unknown>,
    displayName: string,
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest,
    log: Logger,
): Promise<string> {
    const endpoint = `https://api.${auth.site}/api/v2/app-builder/queries/preview-async`;

    log.debug(`Calling Datadog API: ${endpoint}`);

    const body = JSON.stringify({
        data: {
            type: 'queries',
            attributes: {
                query: {
                    id: randomUUID(),
                    name: displayName,
                    type: 'action',
                    properties: {
                        spec: querySpec,
                        onlyTriggerManually: true,
                    },
                },
                template_params: {},
            },
        },
    });

    const initialResult = await doAuthenticatedRequest<{ data?: { id?: string } }>({
        url: endpoint,
        method: 'POST',
        type: 'json',
        getData: () => ({
            data: body,
            headers: { 'Content-Type': 'application/json' },
        }),
    });

    const receiptId = initialResult.data?.id;

    if (!receiptId) {
        throw new Error('No receipt ID returned from Datadog API');
    }

    log.debug(`Query execution started with receipt: ${receiptId}`);

    return receiptId;
}

/**
 * Execute a script via Datadog's app-builder queries API — the existing
 * production round trip, unchanged. Wraps the whole script as a
 * `jsFunctionWithActions` query.
 */
async function executeScriptViaDatadog(
    scriptBody: string,
    func: BackendFunction,
    args: unknown[],
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest,
    log: Logger,
): Promise<BackendOutputs> {
    const displayName = formatRef(func);

    const receiptId = await submitQuery(
        {
            fqn: 'com.datadoghq.datatransformation.jsFunctionWithActions',
            inputs: {
                script: scriptBody,
                allowedConnectionIds: func.allowedConnectionIds,
                context: { backendFunctionArgs: args },
            },
        },
        displayName,
        auth,
        doAuthenticatedRequest,
        log,
    );

    const outputs = await pollQueryExecution(receiptId, auth, doAuthenticatedRequest, log);
    if (typeof outputs !== 'object' || outputs === null || !('data' in outputs)) {
        throw new Error('Query execution completed without a "data" field in its outputs');
    }
    return outputs as BackendOutputs;
}

/**
 * Build the real `$.Actions` implementation local execution injects: each
 * call submits its own direct, single-action `preview-async` query — the
 * action's own `{fqn, inputs, connectionId}`, not wrapped in a
 * `jsFunctionWithActions` script — and polls it the same way the whole-script
 * path does. This is the v1 mechanism decided in the RFC's Decisions and
 * Trade-Offs: it needs nothing new from Action Platform and works today. No
 * auth check happens until an action call is actually made — a script that
 * never calls `$.Actions` runs locally with no auth configured at all.
 */
function makeExecuteActionRemotely(
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest | undefined,
    log: Logger,
): ExecuteAction {
    return async (
        fqn: string,
        inputs: unknown,
        connectionId: string | undefined,
    ): Promise<unknown> => {
        if (!doAuthenticatedRequest) {
            throw new Error(`Auth credentials not configured. ${AUTH_GUIDANCE}`);
        }
        const receiptId = await submitQuery(
            connectionId ? { fqn, inputs, connectionId } : { fqn, inputs },
            fqn,
            auth,
            doAuthenticatedRequest,
            log,
        );
        return pollQueryExecution(receiptId, auth, doAuthenticatedRequest, log);
    };
}

interface PollResult {
    data?: { attributes?: { done?: boolean; outputs?: unknown } };
    errors?: Array<{ detail?: string; title?: string }>;
}

/**
 * Long-poll Datadog API until a submitted query's execution completes or
 * times out. Returns the raw `outputs` value — shape varies by query type
 * (a `jsFunctionWithActions` query wraps its result as `{data: <value>}`;
 * a direct single-action query's `outputs` is that action's own defined
 * output schema) — callers interpret it accordingly.
 *
 * The server holds each poll connection open (~30s) and responds with
 * done: true when the result is ready, or done: false when its long-poll
 * window expires. This loop handles application-level re-polling
 * (done: false), not HTTP retries — doRequest already retries transient
 * HTTP failures (5xx, network errors) internally.
 */
async function pollQueryExecution(
    receiptId: string,
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest,
    log: Logger,
): Promise<unknown> {
    const endpoint = `https://api.${auth.site}/api/v2/app-builder/queries/execution-long-polling/${receiptId}`;
    const maxRetries = 10;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        log.debug(`Long-poll attempt ${attempt + 1}/${maxRetries}...`);

        const result = await doAuthenticatedRequest<PollResult>({
            url: endpoint,
            type: 'json',
        });

        // Check for error responses.
        if (result.errors?.length) {
            const details = result.errors.map((e) => e.detail || e.title).join('; ');
            throw new Error(`Query execution failed: ${details}`);
        }

        const attrs = result.data?.attributes;
        log.debug(`Long-poll response, done: ${attrs?.done}`);

        if (attrs?.done) {
            if (attrs.outputs === undefined) {
                throw new Error('Query execution completed without outputs');
            }
            return attrs.outputs;
        }

        // done === false means server-side long-poll timed out; retry immediately.
    }

    throw new Error('Query execution timed out');
}

/**
 * Send a JSON error response.
 */
function sendError(res: ServerResponse, statusCode: number, message: string): void {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: message } satisfies ExecuteActionResponse));
}

class HttpError extends Error {
    constructor(
        public statusCode: number,
        message: string,
    ) {
        super(message);
    }
}

/**
 * Shared request pipeline: parse body, validate functionName, look up
 * the backend function by encoded query name, and bundle it.
 */
async function validateAndBundle(
    req: IncomingMessage,
    functionsByName: Map<string, BackendFunction>,
    bundle: BundleFn,
): Promise<{ func: BackendFunction; code: string; args: unknown[] }> {
    const { functionName, args = [] } = await parseRequestBody(req);

    if (!functionName || typeof functionName !== 'string') {
        throw new HttpError(400, 'Missing or invalid functionName');
    }

    const func = functionsByName.get(functionName);
    if (!func) {
        throw new HttpError(404, `Backend function "${functionName}" not found`);
    }

    const bundled = await bundle(func);
    return { ...bundled, args };
}

/**
 * Handle POST /__dd/debugBundle — returns the bundled script for inspection.
 */
async function handleDebugBundle(
    req: IncomingMessage,
    res: ServerResponse,
    functionsByName: Map<string, BackendFunction>,
    bundle: BundleFn,
): Promise<void> {
    try {
        const { code } = await validateAndBundle(req, functionsByName, bundle);

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        res.end(code);
    } catch (error: unknown) {
        const statusCode = error instanceof HttpError ? error.statusCode : 500;
        const message = error instanceof Error ? error.message : 'Internal server error';
        sendError(res, statusCode, message);
    }
}

/**
 * Parse the request body and look up the backend function by encoded query
 * name — the same validation `validateAndBundle` does, minus the bundle step
 * `handleExecuteAction` no longer needs.
 */
async function parseAndLookupFunction(
    req: IncomingMessage,
    functionsByName: Map<string, BackendFunction>,
): Promise<{ func: BackendFunction; args: unknown[] }> {
    const { functionName, args = [] } = await parseRequestBody(req);

    if (!functionName || typeof functionName !== 'string') {
        throw new HttpError(400, 'Missing or invalid functionName');
    }

    const func = functionsByName.get(functionName);
    if (!func) {
        throw new HttpError(404, `Backend function "${functionName}" not found`);
    }

    return { func, args };
}

/**
 * Handle POST /__dd/executeAction — imports a backend function's real file
 * directly and executes it in-process (see local-execution.ts); no bundling
 * on this path. Customer-facing default: no auth required upfront, since the
 * script itself doesn't need it — only a real `$.Actions` call does, and
 * that's checked lazily (see makeExecuteActionRemotely).
 */
async function handleExecuteAction(
    req: IncomingMessage,
    res: ServerResponse,
    functionsByName: Map<string, BackendFunction>,
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest | undefined,
    loadModule: LoadModule,
    log: Logger,
): Promise<void> {
    try {
        const { func, args } = await parseAndLookupFunction(req, functionsByName);
        const displayName = formatRef(func);

        log.debug(`Executing action locally: ${displayName} with args`);

        const executeAction = makeExecuteActionRemotely(auth, doAuthenticatedRequest, log);
        const result = await executeScriptLocally(func, args, executeAction, loadModule, log);

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, result } satisfies ExecuteActionResponse));
    } catch (error: unknown) {
        const statusCode = error instanceof HttpError ? error.statusCode : 500;
        const message = error instanceof Error ? error.message : 'Internal server error';
        log.debug(`Error handling executeAction: ${message}`);
        sendError(res, statusCode, message);
    }
}

/**
 * Handle POST /__dd/executeActionViaCloud — bundles a backend function and
 * executes it via the existing production round trip (queue + Deno
 * subprocess). Same behavior as `/__dd/executeAction` before this project:
 * kept as a distinctly-purposed command (`npm run dev:verify`, Milestone 3)
 * for pre-publish parity checks, not a mode flag on the same endpoint.
 */
async function handleExecuteActionViaCloud(
    req: IncomingMessage,
    res: ServerResponse,
    functionsByName: Map<string, BackendFunction>,
    bundle: BundleFn,
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest,
    log: Logger,
): Promise<void> {
    try {
        const { func, code, args } = await validateAndBundle(req, functionsByName, bundle);
        const displayName = formatRef(func);

        log.debug(`Executing action via cloud: ${displayName} with args`);

        const result = await executeScriptViaDatadog(
            code,
            func,
            args,
            auth,
            doAuthenticatedRequest,
            log,
        );

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, result } satisfies ExecuteActionResponse));
    } catch (error: unknown) {
        const statusCode = error instanceof HttpError ? error.statusCode : 500;
        const message = error instanceof Error ? error.message : 'Internal server error';
        log.debug(`Error handling executeActionViaCloud: ${message}`);
        sendError(res, statusCode, message);
    }
}

/**
 * Build a lookup map from encoded query names to BackendFunction objects.
 */
function buildFunctionMap(backendFunctions: BackendFunction[]): Map<string, BackendFunction> {
    return new Map(backendFunctions.map((f) => [encodeQueryName(f), f]));
}

/**
 * Create a Connect-compatible middleware for the Vite dev server.
 * Intercepts backend function requests and handles them via Datadog API.
 *
 * The lookup map is rebuilt on each request via `getBackendFunctions()`
 * so that newly discovered (or renamed/removed) functions are reflected
 * without restarting the dev server.
 */
export function createDevServerMiddleware(
    viteBuild: typeof build,
    loadModule: LoadModule,
    getBackendFunctions: () => BackendFunction[],
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest | undefined,
    projectRoot: string,
    log: Logger,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
    const bundle = (func: BackendFunction) =>
        bundleBackendFunction(viteBuild, func, projectRoot, log);

    const initialFunctions = getBackendFunctions();
    if (initialFunctions.length > 0) {
        log.info(
            `Dev server middleware active for ${initialFunctions.length} backend function(s): ${initialFunctions.map((f) => f.name).join(', ')}`,
        );
    }

    if (!doAuthenticatedRequest) {
        log.warn(
            `Auth credentials not configured. Backend functions that call $.Actions will fail; the /__dd/executeActionViaCloud endpoint will be unavailable. ${AUTH_GUIDANCE}`,
        );
    }

    return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') {
            next();
            return;
        }

        const functionsByName = buildFunctionMap(getBackendFunctions());

        if (req.url === '/__dd/debugBundle') {
            handleDebugBundle(req, res, functionsByName, bundle).catch(() => {
                sendError(res, 500, 'Unexpected error');
            });
        } else if (req.url === '/__dd/executeAction') {
            handleExecuteAction(
                req,
                res,
                functionsByName,
                auth,
                doAuthenticatedRequest,
                loadModule,
                log,
            ).catch(() => {
                sendError(res, 500, 'Unexpected error');
            });
        } else if (req.url === '/__dd/executeActionViaCloud') {
            if (!doAuthenticatedRequest) {
                sendError(res, 400, `Auth credentials not configured. ${AUTH_GUIDANCE}`);
                return;
            }
            handleExecuteActionViaCloud(
                req,
                res,
                functionsByName,
                bundle,
                auth,
                doAuthenticatedRequest,
                log,
            ).catch(() => {
                sendError(res, 500, 'Unexpected error');
            });
        } else {
            next();
        }
    };
}
