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
import type { LongPollingOptions } from '../types';

import { createBackendConnectionIdCollector } from './backend-connection-id-collector';
import { getBaseBackendBuildConfig } from './build-config';

interface BundleResult {
    func: BackendFunction;
    code: string;
}

type BundleFn = (func: BackendFunction) => Promise<BundleResult>;

const DEV_VIRTUAL_PREFIX = 'virtual:dd-backend-dev:';

type AuthConfig = AuthOptionsWithDefaults;
type LongPollingConfig = Required<LongPollingOptions>;

// Kept small on purpose: a `done: false` response is the expected outcome of a
// healthy poll, not a failure, and any delay here is time with no poll in
// flight. The delay exists to de-synchronize concurrent pollers, not to back
// off a broken endpoint.
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 2_000;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * True for the DOMException fetch rejects with when our AbortSignal fires.
 * AbortSignal.timeout() aborts with a TimeoutError; an explicit abort()
 * produces an AbortError.
 *
 * Matches structurally rather than with `instanceof Error`: the rejection is a
 * DOMException built in undici's realm, which fails `instanceof` checks across
 * realm boundaries (vm contexts, the Jest environment).
 */
function isAbortError(error: unknown): boolean {
    if (error === null || typeof error !== 'object' || !('name' in error)) {
        return false;
    }

    return error.name === 'TimeoutError' || error.name === 'AbortError';
}

/**
 * Delay before a long-poll retry attempt, combining exponential backoff and
 * jitter (both standard API auto-retry strategies, and independently
 * toggleable via `LongPollingConfig`).
 *
 * Backoff spaces out repeated retries against a slow/unhealthy endpoint.
 * Jitter prevents multiple concurrent requests (e.g. several backend
 * functions polling at once) from retrying in lockstep against the API.
 *
 * Uses equal jitter (half fixed, half random) rather than full jitter so the
 * delay keeps a floor instead of collapsing towards zero.
 */
function getRetryDelay(attempt: number, config: LongPollingConfig): number {
    const backoffDelay = config.exponentialBackoff
        ? Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS)
        : RETRY_BASE_DELAY_MS;

    return config.jitter ? backoffDelay / 2 + Math.random() * (backoffDelay / 2) : backoffDelay;
}

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
 * Execute a script via Datadog's app-builder queries API.
 */
async function executeScriptViaDatadog(
    scriptBody: string,
    func: BackendFunction,
    args: unknown[],
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest,
    longPolling: LongPollingConfig,
    log: Logger,
): Promise<BackendOutputs> {
    const endpoint = `https://api.${auth.site}/api/v2/app-builder/queries/preview-async`;
    const displayName = formatRef(func);

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
                        spec: {
                            fqn: 'com.datadoghq.datatransformation.jsFunctionWithActions',
                            inputs: {
                                script: scriptBody,
                                allowedConnectionIds: func.allowedConnectionIds,
                                context: { backendFunctionArgs: args },
                            },
                        },
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

interface PollResult {
    data?: { attributes?: { done?: boolean; outputs?: BackendOutputs } };
    errors?: Array<{ detail?: string; title?: string }>;
}

async function pollQueryExecution(
    receiptId: string,
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest,
    longPolling: LongPollingConfig,
    log: Logger,
): Promise<BackendOutputs> {
    const endpoint = `https://api.${auth.site}/api/v2/app-builder/queries/execution-long-polling/${receiptId}`;
    const { maxRetries, timeoutMs } = longPolling;

    /*
     * Long-poll Datadog API until the query execution completes or times out.
     *
     * Executing an action works in two phases:
     * 1. executeScriptViaDatadog sends a POST to preview-async, which starts the
     *    query and returns a receipt ID immediately.
     * 2. This function polls the execution-long-polling endpoint with that receipt ID.
     *    The server holds the connection open (~30s) and responds with done: true when
     *    the result is ready, or done: false when its long-poll window expires.
     *    `timeoutMs` must stay above that window so healthy polls aren't aborted.
     *
     * This loop handles application-level re-polling (done: false) plus attempts that
     * stall past LONG_POLL_TIMEOUT_MS, not HTTP retries: doRequest already retries
     * transient HTTP failures (5xx, network errors) internally.
     * `maxRetries: 1` effectively disables long-polling: a single request is made
     * and its `done: false` response is surfaced as a timeout instead of being retried.
     */
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
                // Bound the attempt so a connection that stalls past the server's
                // long-poll window is abandoned rather than hanging forever. This
                // covers the whole call, including doRequest's internal HTTP retries.
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error: unknown) {
            // A stalled attempt is recoverable: drop this connection and poll
            // again (the receipt stays valid). Anything else is a real failure.
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
            if (!attrs.outputs) {
                throw new Error('Query execution completed without outputs');
            }
            return attrs.outputs;
        }

        // done === false means server-side long-poll timed out; retry (subject to maxRetries).
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
 * Handle POST /__dd/executeAction — bundles a backend function and executes it via Datadog API.
 */
async function handleExecuteAction(
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

        log.debug(`Executing action: ${displayName} with args`);

        const result = await executeScriptViaDatadog(
            code,
            func,
            args,
            auth,
            doAuthenticatedRequest,
            longPolling,
            log,
        );

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
    getBackendFunctions: () => BackendFunction[],
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

    if (!doAuthenticatedRequest) {
        log.warn(
            `Auth credentials not configured. The /__dd/executeAction endpoint will be unavailable. ${AUTH_GUIDANCE}`,
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
            if (!doAuthenticatedRequest) {
                sendError(res, 400, `Auth credentials not configured. ${AUTH_GUIDANCE}`);
                return;
            }
            handleExecuteAction(
                req,
                res,
                functionsByName,
                bundle,
                auth,
                doAuthenticatedRequest,
                longPolling,
                log,
            ).catch(() => {
                sendError(res, 500, 'Unexpected error');
            });
        } else {
            next();
        }
    };
}
