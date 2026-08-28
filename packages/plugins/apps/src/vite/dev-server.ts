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
import { LOCAL_EXECUTION_LOAD_SUFFIX } from '../constants';

import { createBackendConnectionIdCollector } from './backend-connection-id-collector';
import { getBaseBackendBuildConfig } from './build-config';
import type { ExecuteAction, LoadModule } from './local-execution';
import { DEFAULT_TIMEOUT_MS, executeScriptLocally, withTimeout } from './local-execution';

interface BundleResult {
    func: BackendFunction;
    code: string;
}

type BundleFn = (func: BackendFunction) => Promise<BundleResult>;

const DEV_VIRTUAL_PREFIX = 'virtual:dd-backend-dev:';

type AuthConfig = AuthOptionsWithDefaults;

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
 * real action's own `{fqn, inputs}` directly (see `makeExecuteActionRemotely`
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
    return outputs;
}

/** Submits a single-action `preview-async` query per `$.Actions` call (no auth needed until a call is actually made) and logs its result/error, since production's own equivalent signal only reaches Datadog's backend, not the developer's `npm run dev` console. */
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
            throw new HttpError(400, `Auth credentials not configured. ${AUTH_GUIDANCE}`);
        }
        try {
            const receiptId = await submitQuery(
                connectionId ? { fqn, inputs, connectionId } : { fqn, inputs },
                fqn,
                auth,
                doAuthenticatedRequest,
                log,
            );
            const result = await pollQueryExecution(receiptId, auth, doAuthenticatedRequest, log);
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
            if (attrs.outputs === undefined || attrs.outputs === null) {
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
 * Parse the request body and look up the backend function by encoded query
 * name.
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
 * Shared request pipeline: parse body, validate functionName, look up
 * the backend function by encoded query name, and bundle it.
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
        const statusCode = error instanceof HttpError ? error.statusCode : 500;
        const message = error instanceof Error ? error.message : 'Internal server error';
        sendError(res, statusCode, message);
    }
}

/**
 * Handle POST /__dd/executeAction — imports a backend function's real file
 * directly and executes it in-process (see local-execution.ts); no bundling
 * on this path. Auth is required upfront (checked by the caller in
 * createDevServerMiddleware before this is reached), matching production's
 * own auth-before-execution ordering.
 */
async function handleExecuteAction(
    req: IncomingMessage,
    res: ServerResponse,
    functionsByName: Map<string, BackendFunction>,
    auth: AuthConfig,
    doAuthenticatedRequest: DoAuthenticatedRequest | undefined,
    loadModule: LoadModule,
    getAllowedConnectionIds: (entryId: string) => Promise<string[]>,
    projectRoot: string,
    log: Logger,
): Promise<void> {
    try {
        const { func, args } = await parseAndLookupFunction(req, functionsByName);
        const displayName = formatRef(func);

        log.debug(`Executing action locally: ${displayName} with args`);

        // The registry's own `func.allowedConnectionIds` is always `[]` here
        // — only the bundling collector populates it, and this path
        // intentionally skips bundling. Loading the entry once first lets
        // the module-graph collector observe Vite's `server.moduleGraph` for
        // this entry (see collectModuleGraphFromServer), so the connection-ID
        // allowlist reflects the function's actual imports instead of being
        // silently empty. This priming load runs before executeScriptLocally
        // installs its own hang-detection timeout below, and it evaluates the
        // entry's real top-level code (ssrLoadModule, not a parse-only step)
        // — so it needs its own bound, or a customer module with a hanging
        // top-level await would wedge this request forever.
        const entrySpecifier = func.absolutePath + LOCAL_EXECUTION_LOAD_SUFFIX;
        const primedModule = await withTimeout(
            loadModule(entrySpecifier),
            DEFAULT_TIMEOUT_MS,
            `Loading "${displayName}"`,
        );
        // Same reasoning as the priming load above: this reads every reachable module from disk and
        // transforms it, with no bound of its own — a stalled file read or a hung esbuild.transform
        // call would otherwise wedge this request forever.
        const funcWithConnectionIds: BackendFunction = {
            ...func,
            allowedConnectionIds: await withTimeout(
                getAllowedConnectionIds(func.absolutePath),
                DEFAULT_TIMEOUT_MS,
                `Resolving allowed connections for "${displayName}"`,
            ),
        };

        // executeScriptLocally loads this same entry specifier again
        // internally; reuse the module already resolved above instead of
        // making Vite re-run ssrLoadModule for it a second time.
        const loadModuleReusingPrimedEntry: LoadModule = (specifier) =>
            specifier === entrySpecifier ? Promise.resolve(primedModule) : loadModule(specifier);

        const executeAction = makeExecuteActionRemotely(auth, doAuthenticatedRequest, log);
        const result = await executeScriptLocally(
            funcWithConnectionIds,
            projectRoot,
            args,
            executeAction,
            loadModuleReusingPrimedEntry,
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
 * Handle POST /__dd/executeActionViaCloud — bundles a backend function and
 * executes it via the existing production round trip (queue + Deno
 * subprocess). Kept as a distinctly-purposed command (`npm run dev:verify`)
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
    getAllowedConnectionIds: (entryId: string) => Promise<string[]>,
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
            // Matches production, which authenticates before any backend-function code runs (app-builder-api's PreviewAsyncQueryHandler checks the user first, before the query/execution path) — checked here upfront rather than only lazily inside a $.Actions call, so a function that never calls $.Actions isn't a loophole around the same requirement. A local presence check only (not a real credential-validation network call), so it costs no latency on the fast local dev loop.
            if (!doAuthenticatedRequest) {
                sendError(res, 400, `Auth credentials not configured. ${AUTH_GUIDANCE}`);
                return;
            }
            handleExecuteAction(
                req,
                res,
                functionsByName,
                auth,
                doAuthenticatedRequest,
                loadModule,
                getAllowedConnectionIds,
                projectRoot,
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
