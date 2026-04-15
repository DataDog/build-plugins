// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-await-in-loop */

import { doRequest } from '@dd/core/helpers/request';
import type { AuthOptionsWithDefaults, Logger } from '@dd/core/types';
import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { build } from 'vite';

import type { BackendFunction } from '../backend/discovery';
import { encodeQueryName } from '../backend/discovery';
import { generateDevVirtualEntryContent } from '../backend/virtual-entry';

import { getBaseBackendBuildConfig } from './build-config';

type BundleFn = (func: BackendFunction, args: unknown[]) => Promise<string>;

const DEV_VIRTUAL_PREFIX = 'virtual:dd-backend-dev:';

interface ExecuteActionRequest {
    functionName: string;
    args?: unknown[];
}

interface ExecuteActionResponse {
    success: boolean;
    result?: unknown;
    error?: string;
}

type AuthConfig = Required<AuthOptionsWithDefaults>;

/**
 * Format a BackendFunction for display in log/error messages.
 */
function formatRef(func: BackendFunction): string {
    return `${func.path}/${func.name}`;
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
    args: unknown[],
    projectRoot: string,
    log: Logger,
): Promise<string> {
    const displayName = formatRef(func);
    const virtualId = `${DEV_VIRTUAL_PREFIX}${displayName}`;
    const virtualContent = generateDevVirtualEntryContent(
        func.name,
        func.entryPath,
        args,
        projectRoot,
    );

    log.debug(`Bundling backend function "${displayName}" from ${func.entryPath}`);

    const baseConfig = getBaseBackendBuildConfig(projectRoot, { [virtualId]: virtualContent });

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

    log.debug(`Bundled "${displayName}" (${code.length} bytes)`);

    return code;
}

/**
 * Execute a script via Datadog's app-builder queries API.
 */
async function executeScriptViaDatadog(
    scriptBody: string,
    displayName: string,
    auth: AuthConfig,
    log: Logger,
): Promise<unknown> {
    const endpoint = `https://${auth.site}/api/v2/app-builder/queries/preview-async`;

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
                            inputs: { script: scriptBody },
                        },
                        onlyTriggerManually: true,
                    },
                },
                template_params: {},
            },
        },
    });

    const initialResult = await doRequest<{ data?: { id?: string } }>({
        url: endpoint,
        auth,
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

    return pollQueryExecution(receiptId, auth, log);
}

interface PollResult {
    data?: { attributes?: { done?: boolean; outputs?: unknown } };
    errors?: Array<{ detail?: string; title?: string }>;
}

async function pollQueryExecution(
    receiptId: string,
    auth: AuthConfig,
    log: Logger,
): Promise<unknown> {
    const endpoint = `https://${auth.site}/api/v2/app-builder/queries/execution-long-polling/${receiptId}`;
    const maxRetries = 10;

    /*
     * Long-poll Datadog API until the query execution completes or times out.
     *
     * Executing an action works in two phases:
     * 1. executeScriptViaDatadog sends a POST to preview-async, which starts the
     *    query and returns a receipt ID immediately.
     * 2. This function polls the execution-long-polling endpoint with that receipt ID.
     *    The server holds the connection open (~30s) and responds with done: true when
     *    the result is ready, or done: false when its long-poll window expires.
     *
     * This loop handles application-level re-polling (done: false), not HTTP retries.
     * doRequest already retries transient HTTP failures (5xx, network errors) internally.
     */
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        log.debug(`Long-poll attempt ${attempt + 1}/${maxRetries}...`);

        const result = await doRequest<PollResult>({
            url: endpoint,
            auth,
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
): Promise<{ displayName: string; code: string }> {
    const { functionName, args = [] } = await parseRequestBody(req);

    if (!functionName || typeof functionName !== 'string') {
        throw new HttpError(400, 'Missing or invalid functionName');
    }

    const func = functionsByName.get(functionName);
    if (!func) {
        throw new HttpError(404, `Backend function "${functionName}" not found`);
    }

    const code = await bundle(func, args);
    return { displayName: formatRef(func), code };
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
    log: Logger,
): Promise<void> {
    try {
        const { displayName, code } = await validateAndBundle(req, functionsByName, bundle);

        log.debug(`Executing action: ${displayName} with args`);

        const result = await executeScriptViaDatadog(code, displayName, auth, log);

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
 * Rebuilt on each request because in dev mode, transforms fire on-demand
 * as the browser requests modules — the array grows over time.
 */
function buildFunctionMap(backendFunctions: BackendFunction[]): Map<string, BackendFunction> {
    return new Map(backendFunctions.map((f) => [encodeQueryName(f), f]));
}

/**
 * Create a Connect-compatible middleware for the Vite dev server.
 * Intercepts backend function requests and handles them via Datadog API.
 *
 * The `backendFunctions` array is mutable and populated lazily during
 * transforms — the lookup map is rebuilt on each request so newly
 * discovered functions are immediately available.
 */
export function createDevServerMiddleware(
    viteBuild: typeof build,
    backendFunctions: BackendFunction[],
    auth: AuthOptionsWithDefaults,
    projectRoot: string,
    log: Logger,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
    const bundle = (func: BackendFunction, args: unknown[]) =>
        bundleBackendFunction(viteBuild, func, args, projectRoot, log);

    log.info('Dev server middleware active for backend functions');

    // Narrow auth once — executeAction needs all three fields present.
    const fullAuth: AuthConfig | undefined =
        auth.apiKey && auth.appKey
            ? { apiKey: auth.apiKey, appKey: auth.appKey, site: auth.site }
            : undefined;

    if (!fullAuth) {
        log.warn(
            'Auth credentials not configured. The /__dd/executeAction endpoint will be unavailable. ' +
                'Use dd-auth or set DD_API_KEY and DD_APP_KEY to enable remote execution.',
        );
    }

    return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') {
            next();
            return;
        }

        // Rebuild map on each request so lazily-discovered functions are available.
        const functionsByName = buildFunctionMap(backendFunctions);

        if (req.url === '/__dd/debugBundle') {
            handleDebugBundle(req, res, functionsByName, bundle).catch(() => {
                sendError(res, 500, 'Unexpected error');
            });
        } else if (req.url === '/__dd/executeAction') {
            if (!fullAuth) {
                sendError(
                    res,
                    403,
                    'Auth credentials not configured. Set DD_API_KEY and DD_APP_KEY to enable remote execution.',
                );
                return;
            }
            handleExecuteAction(req, res, functionsByName, bundle, fullAuth, log).catch(() => {
                sendError(res, 500, 'Unexpected error');
            });
        } else {
            next();
        }
    };
}
