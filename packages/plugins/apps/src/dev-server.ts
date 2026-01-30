import { readFile } from 'fs/promises';
// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
import type { IncomingMessage, ServerResponse } from 'http';
import path from 'path';

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
 * Load backend function file from the project
 * Tries common file extensions: .ts, .js, .tsx, .jsx
 */
async function loadBackendFunction(functionName: string, projectRoot: string): Promise<string> {
    const extensions = ['.ts', '.js', '.tsx', '.jsx'];
    const backendDir = path.join(projectRoot, 'backend');

    for (const ext of extensions) {
        const filePath = path.join(backendDir, `${functionName}${ext}`);
        try {
            const content = await readFile(filePath, 'utf-8');
            console.log(`Loaded backend function from: ${filePath}`);
            return content;
        } catch (error: any) {
            // File doesn't exist, try next extension
            if (error.code !== 'ENOENT') {
                // Some other error occurred, rethrow
                throw error;
            }
        }
    }

    throw new Error(
        `Backend function "${functionName}" not found. Looked in: ${backendDir}/${functionName}{${extensions.join(',')}}`,
    );
}

/**
 * Transform backend function code into Datadog App Builder script body format
 * Wraps the function in a main() export that accepts the $ context
 */
function transformToScriptBody(functionCode: string, functionName: string, args: any[]): string {
    // Remove any existing export keywords from the original function
    const cleanedCode = functionCode.replace(/^export\s+(async\s+)?function/, 'async function');

    // Build the script body that wraps the original function
    const scriptBody = `import * as _ from 'lodash';
// Use \`_\` to access Lodash. See https://lodash.com/ for reference.

${cleanedCode}

/** @param {import('./context.types').Context} $ */
export async function main($) {
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
): Promise<any> {
    const endpoint = `https://${site}/api/v2/workflows/${workflowId}/single_action_runs/${executionId}`;
    const maxAttempts = 30; // 30 attempts
    const pollInterval = 1000; // 1 second

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        console.log(`Polling attempt ${attempt + 1}/${maxAttempts}...`);

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

        const result = await response.json();
        const state = result.data?.attributes?.state;

        console.log(`Execution state: ${state}`);

        if (state === 'SUCCEEDED') {
            return result.data.attributes.outputs;
        } else if (state === 'FAILED') {
            throw new Error(`Action execution failed: ${JSON.stringify(result.data.attributes)}`);
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

    console.log(`Calling Datadog API: ${endpoint}`);

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

    const initialResult = await response.json();
    const executionId = initialResult.data?.id;

    if (!executionId) {
        throw new Error('No execution ID returned from Datadog API');
    }

    console.log(`Action started with ID: ${executionId}`);

    // Poll for result
    const outputs = await pollActionExecution(workflowId, executionId, apiKey, appKey, site);

    return outputs;
}

interface AuthConfig {
    apiKey: string;
    appKey: string;
    site: string;
}

/**
 * Handle /__dd/executeAction requests
 */
export async function handleExecuteAction(
    req: IncomingMessage,
    res: ServerResponse,
    projectRoot: string,
    auth: AuthConfig,
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

        console.log(`Executing action: ${functionName} with args:`, args);

        // Load backend function file
        const functionCode = await loadBackendFunction(functionName, projectRoot);
        console.log(`Loaded function code (${functionCode.length} bytes)`);

        // Transform to script body
        const scriptBody = transformToScriptBody(functionCode, functionName, args);
        console.log(`Transformed to script body (${scriptBody.length} bytes)`);

        // Execute via Datadog API
        const apiResult = await executeScriptViaDatadog(
            scriptBody,
            auth.apiKey,
            auth.appKey,
            auth.site,
        );
        console.log('Datadog API response:', apiResult);

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
        console.error('Error handling executeAction:', error);
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
