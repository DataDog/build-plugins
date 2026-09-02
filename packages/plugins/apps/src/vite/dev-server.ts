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
import type { BackendFunction, BackendOutputs } from '../backend/types';
import { generateDevVirtualEntryContent } from '../backend/virtual-entry';
import type { LongPollingOptions } from '../types';

import { createBackendConnectionIdCollector } from './backend-connection-id-collector';
import { createBackendStaticChecksPlugin } from './backend-static-checks-plugin';
import { getBaseBackendBuildConfig } from './build-config';
import type { ExecuteAction, LoadModule } from './local-execution';
import { DEFAULT_TIMEOUT_MS, executeColdActionLocally } from './local-execution';
import { getMaxRetryDelayMs } from './retry-delay';

interface BundleResult {
    func: BackendFunction;
    code: string;
}

type BundleFn = (func: BackendFunction) => Promise<BundleResult>;

const DEV_VIRTUAL_PREFIX = 'virtual:dd-backend-dev:';

type AuthConfig = AuthOptionsWithDefaults;
type LongPollingConfig = Required<LongPollingOptions>;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

// Structural check: the rejection is a DOMException from undici's realm, so
// `instanceof` fails across realms (vm contexts, Jest).
function isAbortError(error: unknown): boolean {
    if (error === null || typeof error !== 'object' || !('name' in error)) {
        return false;
    }

    return error.name === 'TimeoutError' || error.name === 'AbortError';
}

// Equal jitter (half fixed, half random) so the delay keeps a floor.
export function getRetryDelay(attempt: number, config: LongPollingConfig): number {
    const backoffDelay = getMaxRetryDelayMs(attempt, config.exponentialBackoff);

    return config.jitter ? backoffDelay / 2 + Math.random() * (backoffDelay / 2) : backoffDelay;
}

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

    const staticChecksPlugin = createBackendStaticChecksPlugin(
        projectRoot,
        log,
        connectionIdCollector.getModuleRecords,
    );
    const baseConfig = getBaseBackendBuildConfig(projectRoot, { [virtualId]: virtualContent }, [
        connectionIdCollector.plugin,
        staticChecksPlugin,
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
 * Submits a query to Datadog's `preview-async` endpoint and long-polls until it resolves,
 * returning the raw `outputs`. `querySpec` is either the `jsFunctionWithActions` wrapper or
 * a single action's `{fqn, inputs}` — `submitQuery` doesn't care which.
 */
async function submitQuery(
    querySpec: Record<string, unknown>,
    displayName: string,
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest,
    longPolling: LongPollingConfig,
    log: Logger,
): Promise<unknown> {
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

    return pollQueryExecution(receiptId, auth, doAuthenticatedRequest, longPolling, log);
}

/** Executes a script via Datadog's app-builder queries API — the production round trip, wrapping the whole script as a `jsFunctionWithActions` query. */
async function executeScriptViaDatadog(
    scriptBody: string,
    func: BackendFunction,
    args: unknown[],
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest,
    longPolling: LongPollingConfig,
    log: Logger,
): Promise<BackendOutputs> {
    const displayName = formatRef(func);

    const outputs = await submitQuery(
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
        longPolling,
        log,
    );

    if (typeof outputs !== 'object' || outputs === null || !('data' in outputs)) {
        throw new Error('Query execution completed without a "data" field in its outputs');
    }
    return outputs;
}

/** Submits a single-action `preview-async` query per `$.Actions` call and logs its result/error, since production's equivalent signal never reaches the `npm run dev` console. Callers must have already confirmed auth is configured (see `createDevServerMiddleware`). */
function makeExecuteActionRemotely(
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest,
    longPolling: LongPollingConfig,
    log: Logger,
): ExecuteAction {
    return async (
        fqn: string,
        inputs: unknown,
        connectionId: string | undefined,
    ): Promise<unknown> => {
        try {
            const result = await submitQuery(
                connectionId !== undefined ? { fqn, inputs, connectionId } : { fqn, inputs },
                fqn,
                auth,
                doAuthenticatedRequest,
                longPolling,
                log,
            );
            log.info(`$.Actions call to "${fqn}" succeeded: ${JSON.stringify(result)}`);
            return result;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            log.error(`$.Actions call to "${fqn}" failed: ${message}`);
            throw error;
        }
    };
}

interface PollResult {
    data?: { attributes?: { done?: boolean; outputs?: unknown } };
    errors?: Array<{ detail?: string; title?: string }>;
}

/**
 * Long-polls until a submitted query completes or times out, returning the raw `outputs` —
 * shape varies by query type, so callers interpret it. The server holds each poll open ~30s
 * and responds `done: false` on timeout; this loop only handles that re-polling, since
 * `doRequest` already retries transient HTTP failures.
 */
async function pollQueryExecution(
    receiptId: string,
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest,
    longPolling: LongPollingConfig,
    log: Logger,
): Promise<unknown> {
    const endpoint = `https://api.${auth.site}/api/v2/app-builder/queries/execution-long-polling/${receiptId}`;
    const { maxRetries, timeoutMs } = longPolling;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (attempt > 0) {
            const retryDelay = getRetryDelay(attempt, longPolling);
            log.debug(`Waiting ${Math.round(retryDelay)}ms before long-poll retry...`);
            await delay(retryDelay);
        }

        log.debug(`Long-poll attempt ${attempt + 1}/${maxRetries}...`);

        let result: PollResult;
        try {
            result = await doAuthenticatedRequest<PollResult>({
                url: endpoint,
                type: 'json',
                // Bounds the whole call, doRequest's internal retries included.
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error: unknown) {
            // A stall is recoverable: the receipt stays valid, so poll again.
            if (!isAbortError(error)) {
                throw error;
            }
            log.debug(`Long-poll attempt ${attempt + 1} timed out after ${timeoutMs}ms`);
            continue;
        }

        // Check for error responses.
        if (result.errors?.length) {
            const details = result.errors.map((e) => e.detail || e.title).join('; ');
            throw new Error(`Query execution failed: ${details}`);
        }

        const attrs = result.data?.attributes;
        log.debug(`Long-poll response, done: ${attrs?.done}`);

        if (attrs?.done) {
            if (attrs.outputs === undefined || attrs.outputs === null) {
                throw new Error('Query execution completed without outputs');
            }
            return attrs.outputs;
        }

        // `done: false` means the server-side window expired; retry.
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

/**
 * Send a JSON success response.
 */
function sendSuccess(res: ServerResponse, result: { data: unknown }): void {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, result } satisfies ExecuteActionResponse));
}

/**
 * Runs `run` only once auth is configured, matching production's auth-before-execution
 * ordering — checked upfront, not lazily inside a $.Actions call, so a function that never
 * calls $.Actions isn't a loophole. A local presence check only, adding no latency.
 */
function guardAuthenticated(
    res: ServerResponse,
    doAuthenticatedRequest: DoAuthenticatedRequest | undefined,
    run: (doAuthenticatedRequest: DoAuthenticatedRequest) => Promise<void>,
): void {
    if (!doAuthenticatedRequest) {
        sendError(res, 400, `Auth credentials not configured. ${AUTH_GUIDANCE}`);
        return;
    }
    run(doAuthenticatedRequest).catch(() => sendError(res, 500, 'Unexpected error'));
}

/** Shared catch-block shape for every handler below: an `HttpError` carries its own status code, anything else is a 500. `label` is omitted for handlers with no `log` in scope. */
function handleHttpError(res: ServerResponse, error: unknown, log?: Logger, label?: string): void {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : 'Internal server error';
    if (log && label) {
        log.debug(`Error handling ${label}: ${message}`);
    }
    sendError(res, statusCode, message);
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
 * Split out from `validateAndBundle` so `handleExecuteAction`'s no-bundling local path can
 * reuse the same parse-and-lookup step without pulling in a bundle.
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
 * Shared by `handleDebugBundle` and `handleExecuteActionViaCloud` — the two handlers that
 * still need a bundle; `handleExecuteAction`'s no-bundling path calls `parseAndLookupFunction`
 * directly instead.
 */
async function validateAndBundle(
    req: IncomingMessage,
    functionsByName: Map<string, BackendFunction>,
    bundle: BundleFn,
): Promise<{ func: BackendFunction; code: string; args: unknown[] }> {
    const { func, args } = await parseAndLookupFunction(req, functionsByName);
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
        handleHttpError(res, error);
    }
}

/**
 * Handles POST /__dd/executeAction — imports a backend function's real file and executes
 * it in-process (see local-execution.ts), with no bundling. Auth is checked upfront by the
 * caller in `createDevServerMiddleware`, matching production's auth-before-execution ordering.
 */
async function handleExecuteAction(
    req: IncomingMessage,
    res: ServerResponse,
    functionsByName: Map<string, BackendFunction>,
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest,
    longPolling: LongPollingConfig,
    loadModule: LoadModule,
    getAllowedConnectionIds: (entryId: string) => Promise<string[]>,
    projectRoot: string,
    log: Logger,
): Promise<void> {
    try {
        const { func, args } = await parseAndLookupFunction(req, functionsByName);
        const displayName = formatRef(func);

        log.debug(`Executing action locally: ${displayName} with args`);

        // Priming and connection-ID collection must happen inside the same serialization
        // boundary as execution — see executeColdActionLocally's doc comment for why.
        const executeAction = makeExecuteActionRemotely(
            auth,
            doAuthenticatedRequest,
            longPolling,
            log,
        );
        const result = await executeColdActionLocally(
            func,
            projectRoot,
            args,
            executeAction,
            loadModule,
            getAllowedConnectionIds,
            log,
            DEFAULT_TIMEOUT_MS,
            longPolling,
        );

        sendSuccess(res, result);
    } catch (error: unknown) {
        handleHttpError(res, error, log, 'executeAction');
    }
}

/**
 * Handles POST /__dd/executeActionViaCloud — bundles a backend function and executes it via
 * the production round trip (queue + Deno subprocess), kept as its own endpoint
 * (`npm run dev:verify`) for pre-publish parity checks rather than a mode flag.
 */
async function handleExecuteActionViaCloud(
    req: IncomingMessage,
    res: ServerResponse,
    functionsByName: Map<string, BackendFunction>,
    bundle: BundleFn,
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest,
    longPolling: LongPollingConfig,
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
            longPolling,
            log,
        );

        sendSuccess(res, result);
    } catch (error: unknown) {
        handleHttpError(res, error, log, 'executeActionViaCloud');
    }
}

/**
 * Build a lookup map from encoded query names to BackendFunction objects.
 */
function buildFunctionMap(backendFunctions: BackendFunction[]): Map<string, BackendFunction> {
    return new Map(backendFunctions.map((f) => [encodeQueryName(f), f]));
}

/**
 * Connect-compatible middleware intercepting backend function requests for the Vite dev server.
 * The lookup map rebuilds on each request via `getBackendFunctions()` so renamed/removed
 * functions are reflected without restarting the server.
 */
export function createDevServerMiddleware(
    viteBuild: typeof build,
    loadModule: LoadModule,
    getBackendFunctions: () => BackendFunction[],
    getAllowedConnectionIds: (entryId: string) => Promise<string[]>,
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest | undefined,
    longPolling: LongPollingConfig,
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
            guardAuthenticated(res, doAuthenticatedRequest, (authedRequest) =>
                handleExecuteAction(
                    req,
                    res,
                    functionsByName,
                    auth,
                    authedRequest,
                    longPolling,
                    loadModule,
                    getAllowedConnectionIds,
                    projectRoot,
                    log,
                ),
            );
        } else if (req.url === '/__dd/executeActionViaCloud') {
            guardAuthenticated(res, doAuthenticatedRequest, (authedRequest) =>
                handleExecuteActionViaCloud(
                    req,
                    res,
                    functionsByName,
                    bundle,
                    auth,
                    authedRequest,
                    longPolling,
                    log,
                ),
            );
        } else {
            next();
        }
    };
}
