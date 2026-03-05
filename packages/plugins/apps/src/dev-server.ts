// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
/* eslint-disable no-await-in-loop */
import type { Logger } from '@dd/core/types';
import * as esbuild from 'esbuild';
import { mkdir, readFile, rm } from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import { tmpdir } from 'os';
import path from 'path';
import type { ViteDevServer } from 'vite';

interface ExecuteActionRequest {
    functionName: string;
    args?: any[];
}

interface ExecuteActionResponse {
    success: boolean;
    result?: any;
    error?: string;
}

/**
 * Parse JSON body from incoming request stream
 */
async function parseRequestBody(req: IncomingMessage): Promise<ExecuteActionRequest> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Find backend function file path from the project
 * Supports two patterns:
 * 1. Single file module: backend/functionName.{ts,js,tsx,jsx}
 * 2. Directory module: backend/functionName/index.{ts,js,tsx,jsx}
 */
async function findBackendFunctionPath(functionName: string, projectRoot: string): Promise<string> {
    const extensions = ['.ts', '.js', '.tsx', '.jsx'];
    const backendDir = path.join(projectRoot, 'backend');
    const searchPaths: string[] = [];

    // Try directory module pattern first: backend/functionName/index.{ext}
    for (const ext of extensions) {
        const dirPath = path.join(backendDir, functionName, `index${ext}`);
        searchPaths.push(dirPath);
        try {
            await readFile(dirPath, 'utf-8');
            return dirPath;
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    // Try single file module pattern: backend/functionName.{ext}
    for (const ext of extensions) {
        const filePath = path.join(backendDir, `${functionName}${ext}`);
        searchPaths.push(filePath);
        try {
            await readFile(filePath, 'utf-8');
            return filePath;
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    throw new Error(
        `Backend function "${functionName}" not found. Searched:\n  - ${searchPaths.join('\n  - ')}`,
    );
}

/**
 * Bundle backend function using esbuild directly
 * This properly handles TypeScript, dependency resolution, and creates a single bundle
 * without needing to resolve tsconfig.json files
 */
async function bundleBackendFunction(
    functionName: string,
    projectRoot: string,
    viteServer: ViteDevServer | undefined,
    log: Logger,
): Promise<string> {
    const filePath = await findBackendFunctionPath(functionName, projectRoot);
    log.debug(`Found backend function at: ${filePath}`);

    // Create a temporary directory for the build output
    const tempDir = path.join(tmpdir(), `dd-apps-bundle-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    log.debug(`Building bundle to: ${tempDir}`);

    const bundlePath = path.join(tempDir, 'bundle.js');

    // Use a virtual entry that re-exports the backend function and also
    // forces setExecuteActionImplementation into the bundle (esbuild would
    // otherwise tree-shake it since no backend code calls it directly).
    await esbuild.build({
        stdin: {
            contents: [
                `export * from ${JSON.stringify(filePath)};`,
                `export { setExecuteActionImplementation } from '@datadog/action-catalog/action-execution';`,
            ].join('\n'),
            resolveDir: projectRoot,
            loader: 'ts',
        },
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'esnext',
        outfile: bundlePath,
        absWorkingDir: projectRoot, // Set working directory for correct module resolution
        conditions: ['node', 'import'], // Help resolve package.json exports for Node environment
        mainFields: ['module', 'main'], // Fallback resolution for packages without exports
        minify: false,
        sourcemap: false,
        // Mark Node.js built-ins as external
        external: [
            'fs',
            'path',
            'os',
            'http',
            'https',
            'crypto',
            'stream',
            'buffer',
            'util',
            'events',
            'url',
            'querystring',
        ],
    });

    // Read the bundled output
    const bundledCode = await readFile(bundlePath, 'utf-8');
    log.debug(`Bundled function (${bundledCode.length} bytes)`);

    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true });

    return bundledCode;
}

/**
 * Transform bundled backend function code into Datadog App Builder script body format
 * The bundled code is already transformed JavaScript with dependencies resolved
 * We need to wrap it in a main() export that accepts the $ context
 */
function transformToScriptBody(bundledCode: string, functionName: string, args: any[]): string {
    // The bundled code from Vite contains the transformed function and its dependencies
    // We need to clean up export statements and wrap it properly
    let cleanedCode = bundledCode;

    // Remove export default statements and convert to regular function
    cleanedCode = cleanedCode.replace(/export\s+default\s+/g, '');

    // Convert named exports to regular declarations
    cleanedCode = cleanedCode.replace(/export\s+(async\s+)?function\s+/g, '$1function ');
    cleanedCode = cleanedCode.replace(/export\s+(const|let|var)\s+/g, '$1 ');

    // Build the script body that includes the bundled code and wraps the function call
    const scriptBody = `import * as _ from 'lodash';
// Use \`_\` to access Lodash. See https://lodash.com/ for reference.

${cleanedCode}

/** @param {import('./context.types').Context} $ */
export async function main($) {
    // Register the $.Actions-based implementation for executeAction
    setExecuteActionImplementation(async (actionId, request) => {
        const actionPath = actionId.replace(/^com\\.datadoghq\\./, '');
        const pathParts = actionPath.split('.');
        let actionFn = $.Actions;
        for (const part of pathParts) {
            if (!actionFn) throw new Error('Action not found: ' + actionId);
            actionFn = actionFn[part];
        }
        if (typeof actionFn !== 'function') throw new Error('Action is not a function: ' + actionId);
        return actionFn(request);
    });

    // Execute the backend function with provided arguments
    const result = await ${functionName}(...${JSON.stringify(args)});
    return result;
}`;

    return scriptBody;
}

/**
 * Poll for action execution result
 */
async function pollActionExecution(
    workflowId: string,
    executionId: string,
    apiKey: string,
    appKey: string,
    site: string,
    log: Logger,
): Promise<any> {
    const endpoint = `https://${site}/api/v2/workflows/${workflowId}/single_action_runs/${executionId}`;
    const maxAttempts = 30; // 30 attempts
    const pollInterval = 1000; // 1 second

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        log.debug(`Polling attempt ${attempt + 1}/${maxAttempts}...`);

        const response = await fetch(endpoint, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'DD-API-KEY': apiKey,
                'DD-APPLICATION-KEY': appKey,
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Datadog API error (${response.status}): ${errorText}`);
        }

        const result = (await response.json()) as any;
        const state = result.data?.attributes?.state;

        log.debug(`Execution state: ${state}`);

        if (state === 'SUCCEEDED') {
            return result.data.attributes.outputs;
        } else if (state === 'FAILED' || state === 'EXECUTION_FAILED') {
            const errorDetails = result.data.attributes.error || result.data.attributes;
            log.debug(`Action execution failed: ${JSON.stringify(errorDetails)}`);
            throw new Error(`Action execution failed: ${JSON.stringify(errorDetails)}`);
        }

        // Still pending, wait before next poll
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error('Action execution timed out');
}

/**
 * Execute script via Datadog single_action_runs API
 */
async function executeScriptViaDatadog(
    scriptBody: string,
    apiKey: string,
    appKey: string,
    site: string,
    log: Logger,
): Promise<any> {
    // Hardcoded workflow ID for development
    const workflowId = '380e7df1-729c-420c-b15e-a3b8e6347d49';
    const endpoint = `https://${site}/api/v2/workflows/${workflowId}/single_action_runs`;

    const requestBody = {
        data: {
            type: 'single_action_runs',
            attributes: {
                actionId: 'com.datadoghq.datatransformation.jsFunctionWithActions',
                inputs: {
                    script: scriptBody,
                    context: {},
                },
            },
        },
    };
    log.debug(`Script body: ${JSON.stringify(requestBody.data.attributes.inputs.script)}`);

    log.debug(`Calling Datadog API: ${endpoint}`);

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'DD-API-KEY': apiKey,
            'DD-APPLICATION-KEY': appKey,
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Datadog API error (${response.status}): ${errorText}`);
    }

    const initialResult = (await response.json()) as any;
    const executionId = initialResult.data?.id;

    if (!executionId) {
        throw new Error('No execution ID returned from Datadog API');
    }

    log.debug(`Action started with ID: ${executionId}`);

    // Poll for result
    const outputs = await pollActionExecution(workflowId, executionId, apiKey, appKey, site, log);

    return outputs;
}

interface AuthConfig {
    apiKey: string;
    appKey: string;
    site: string;
}

/**
 * Handle /__dd/debugBundle requests - returns the bundled code for inspection
 */
export async function handleDebugBundle(
    req: IncomingMessage,
    res: ServerResponse,
    projectRoot: string,
    log: Logger,
    viteServer?: ViteDevServer,
): Promise<void> {
    try {
        const { functionName } = await parseRequestBody(req);

        if (!functionName || typeof functionName !== 'string') {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Missing or invalid functionName' }));
            return;
        }

        const functionCode = await bundleBackendFunction(
            functionName,
            projectRoot,
            viteServer,
            log,
        );

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        res.end(functionCode);
    } catch (error: any) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message || 'Internal server error' }));
    }
}

/**
 * Handle /__dd/executeAction requests
 */
export async function handleExecuteAction(
    req: IncomingMessage,
    res: ServerResponse,
    projectRoot: string,
    auth: AuthConfig,
    log: Logger,
    viteServer?: ViteDevServer,
): Promise<void> {
    try {
        const { functionName, args = [] } = await parseRequestBody(req);

        if (!functionName || typeof functionName !== 'string') {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(
                JSON.stringify({
                    success: false,
                    error: 'Missing or invalid functionName',
                } as ExecuteActionResponse),
            );
            return;
        }

        log.debug(`Executing action: ${functionName} with args: ${JSON.stringify(args)}`);

        // Bundle backend function file using Vite
        const functionCode = await bundleBackendFunction(
            functionName,
            projectRoot,
            viteServer,
            log,
        );
        log.debug(`Bundled function code (${functionCode.length} bytes)`);
        log.debug(`Bundled code preview:\n${functionCode.substring(0, 500)}`);

        // Transform to script body
        const scriptBody = transformToScriptBody(functionCode, functionName, args);
        log.debug(`Transformed to script body (${scriptBody.length} bytes)`);
        log.debug(`Script body preview:\n${scriptBody.substring(0, 500)}`);

        // Execute via Datadog API
        const apiResult = await executeScriptViaDatadog(
            scriptBody,
            auth.apiKey,
            auth.appKey,
            auth.site,
            log,
        );
        log.debug('Datadog API response:', apiResult);

        // Return the result from Datadog
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
            JSON.stringify({
                success: true,
                result: apiResult,
            } as ExecuteActionResponse),
        );
    } catch (error: any) {
        log.debug(`Error handling executeAction: ${error}`);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(
            JSON.stringify({
                success: false,
                error: error.message || 'Internal server error',
            } as ExecuteActionResponse),
        );
    }
}
