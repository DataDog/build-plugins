// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-disable no-await-in-loop */

import { doRequest } from '@dd/core/helpers/request';
import type { AuthOptions, Logger } from '@dd/core/types';
import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { build } from 'vite';

import type { BackendFunction } from '../discovery';
import { generateDevVirtualEntryContent } from '../virtual-entry';

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

type AuthConfig = Required<AuthOptions>;

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
    const virtualId = `${DEV_VIRTUAL_PREFIX}${func.name}`;
    const virtualContent = generateDevVirtualEntryContent(
        func.name,
        func.entryPath,
        args,
        projectRoot,
    );

    log.debug(`Bundling backend function "${func.name}" from ${func.entryPath}`);

    const baseConfig = getBaseBackendBuildConfig(projectRoot, { [virtualId]: virtualContent });

    // Dev: build a single function in-memory per request so we can send the
    // bundled script to the Datadog API without writing temp files.
    // Uses a plain "virtual:" prefix instead of \0 because Rollup generates
    // empty chunks when \0-prefixed IDs are used as input entries.
    // inlineDynamicImports collapses everything into one chunk since we only
    // have a single entry (incompatible with multi-entry builds).
    const result = await viteBuild({
        ...baseConfig,
        build: {
            ...baseConfig.build,
            write: false,
            rollupOptions: {
                ...baseConfig.build.rollupOptions,
                input: virtualId,
                output: { ...baseConfig.build.rollupOptions.output, inlineDynamicImports: true },
            },
        },
    });

    const output = Array.isArray(result) ? result[0] : result;

    if (!('output' in output)) {
        throw new Error(`Unexpected vite.build result for "${func.name}"`);
    }

    const code = output.output[0].type === 'chunk' ? output.output[0].code : '';

    log.debug(`Bundled "${func.name}" (${code.length} bytes)`);

    return code;
}

/**
 * Execute a script via Datadog's app-builder queries API.
 */
async function executeScriptViaDatadog(
    scriptBody: string,
    functionName: string,
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
                    name: functionName,
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

/**
 * Long-poll Datadog API until the query execution completes or times out.
 * The server holds the connection open until the result is ready or its own timeout expires.
 *
 * Note: this loop is not retry-on-error — it re-polls because the server returns
 * done: false when its own long-poll window expires. HTTP-level retries are handled
 * by doRequest internally.
 */
async function pollQueryExecution(
    receiptId: string,
    auth: AuthConfig,
    log: Logger,
): Promise<unknown> {
    const endpoint = `https://${auth.site}/api/v2/app-builder/queries/execution-long-polling/${receiptId}`;
    // Each long-poll request waits server-side (~30s). Max retries provides a safety net.
    const maxRetries = 10;

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
        const { functionName, args = [] } = await parseRequestBody(req);

        if (!functionName || typeof functionName !== 'string') {
            sendError(res, 400, 'Missing or invalid functionName');
            return;
        }

        const func = functionsByName.get(functionName);
        if (!func) {
            sendError(res, 404, `Backend function "${functionName}" not found`);
            return;
        }

        const code = await bundle(func, args);

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        res.end(code);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Internal server error';
        sendError(res, 500, message);
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
        const { functionName, args = [] } = await parseRequestBody(req);

        if (!functionName || typeof functionName !== 'string') {
            sendError(res, 400, 'Missing or invalid functionName');
            return;
        }

        const func = functionsByName.get(functionName);
        if (!func) {
            sendError(res, 404, `Backend function "${functionName}" not found`);
            return;
        }

        log.debug(`Executing action: ${functionName} with args: ${JSON.stringify(args)}`);

        const scriptBody = await bundle(func, args);

        const result = await executeScriptViaDatadog(scriptBody, functionName, auth, log);

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, result } satisfies ExecuteActionResponse));
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Internal server error';
        log.debug(`Error handling executeAction: ${message}`);
        sendError(res, 500, message);
    }
}

/**
 * Create a Connect-compatible middleware for the Vite dev server.
 * Intercepts backend function requests and handles them via Datadog API.
 */
export function createDevServerMiddleware(
    viteBuild: typeof build,
    backendFunctions: BackendFunction[],
    auth: AuthConfig,
    projectRoot: string,
    log: Logger,
): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
    const functionsByName = new Map(backendFunctions.map((f) => [f.name, f]));

    const bundle = (func: BackendFunction, args: unknown[]) =>
        bundleBackendFunction(viteBuild, func, args, projectRoot, log);

    log.info(
        `Dev server middleware active for ${backendFunctions.length} backend function(s): ${backendFunctions.map((f) => f.name).join(', ')}`,
    );

    return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') {
            next();
            return;
        }

        if (req.url === '/__dd/debugBundle') {
            handleDebugBundle(req, res, functionsByName, bundle).catch(() => {
                sendError(res, 500, 'Unexpected error');
            });
        } else if (req.url === '/__dd/executeAction') {
            handleExecuteAction(req, res, functionsByName, bundle, auth, log).catch(() => {
                sendError(res, 500, 'Unexpected error');
            });
        } else {
            next();
        }
    };
}
