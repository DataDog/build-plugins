// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import { randomUUID } from 'crypto';
import * as esbuild from 'esbuild';
import { mkdir, readdir, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

export interface BackendFunction {
    name: string;
    entryPath: string;
}

interface BackendFunctionQuery {
    id: string;
    type: string;
    name: string;
    properties: {
        spec: {
            fqn: string;
            inputs: {
                script: string;
            };
        };
    };
}

interface AuthConfig {
    apiKey: string;
    appKey: string;
    site: string;
}

const EXTENSIONS = ['.ts', '.js', '.tsx', '.jsx'];
const JS_FUNCTION_WITH_ACTIONS_FQN = 'com.datadoghq.datatransformation.jsFunctionWithActions';
const NODE_EXTERNALS = [
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
];

/**
 * Discover backend functions in the backend directory.
 * Supports two patterns:
 *   - Single file module: backend/functionName.{ts,js,tsx,jsx}
 *   - Directory module: backend/functionName/index.{ts,js,tsx,jsx}
 */
export async function discoverBackendFunctions(
    backendDir: string,
    log: Logger,
): Promise<BackendFunction[]> {
    let entries: string[];
    try {
        entries = await readdir(backendDir);
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            log.debug(`No backend directory found at ${backendDir}`);
            return [];
        }
        throw error;
    }

    const functions: BackendFunction[] = [];

    for (const entry of entries) {
        const entryPath = path.join(backendDir, entry);
        const entryStat = await stat(entryPath);

        if (entryStat.isDirectory()) {
            // Directory module: backend/functionName/index.{ext}
            for (const ext of EXTENSIONS) {
                const indexPath = path.join(entryPath, `index${ext}`);
                try {
                    await stat(indexPath);
                    functions.push({ name: entry, entryPath: indexPath });
                    break;
                } catch {
                    // Try next extension
                }
            }
        } else if (entryStat.isFile()) {
            // Single file module: backend/functionName.{ext}
            const ext = path.extname(entry);
            if (EXTENSIONS.includes(ext)) {
                const name = path.basename(entry, ext);
                functions.push({ name, entryPath });
            }
        }
    }

    log.debug(
        `Discovered ${functions.length} backend function(s): ${functions.map((f) => f.name).join(', ')}`,
    );
    return functions;
}

/**
 * Bundle a backend function using esbuild.
 * Same approach as dev-server.ts bundleBackendFunction but without vite server dependency.
 */
async function bundleFunction(
    func: BackendFunction,
    projectRoot: string,
    log: Logger,
): Promise<string> {
    const tempDir = path.join(tmpdir(), `dd-apps-backend-bundle-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    const bundlePath = path.join(tempDir, 'bundle.js');

    try {
        await esbuild.build({
            stdin: {
                contents: [
                    `export * from ${JSON.stringify(func.entryPath)};`,
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
            absWorkingDir: projectRoot,
            conditions: ['node', 'import'],
            mainFields: ['module', 'main'],
            minify: false,
            sourcemap: false,
            external: NODE_EXTERNALS,
        });

        const bundledCode = await readFile(bundlePath, 'utf-8');
        log.debug(`Bundled backend function "${func.name}" (${bundledCode.length} bytes)`);
        return bundledCode;
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

/**
 * Transform bundled code into the Action Platform script format.
 * Per the RFC, the script is wrapped in a main($) entry point with globalThis.$ = $.
 * Args are passed via App Builder's template expression system (backendFunctionRequest).
 */
function transformToProductionScript(bundledCode: string, functionName: string): string {
    let cleanedCode = bundledCode;

    // Remove export default statements
    cleanedCode = cleanedCode.replace(/export\s+default\s+/g, '');
    // Convert named exports to regular declarations
    cleanedCode = cleanedCode.replace(/export\s+(async\s+)?function\s+/g, '$1function ');
    cleanedCode = cleanedCode.replace(/export\s+(const|let|var)\s+/g, '$1 ');

    // The backendFunctionRequest template param is resolved at query execution time
    // by the executeBackendFunction client via the template_params mechanism.
    const scriptBody = `${cleanedCode}

/** @param {import('./context.types').Context} $ */
export async function main($) {
    globalThis.$ = $;

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

    const result = await ${functionName}();
    return result;
}`;

    return scriptBody;
}

/**
 * Build the ActionQuery objects for each backend function.
 */
function buildQueries(functions: { name: string; script: string }[]): BackendFunctionQuery[] {
    return functions.map((func) => ({
        id: randomUUID(),
        type: 'action',
        name: func.name,
        properties: {
            spec: {
                fqn: JS_FUNCTION_WITH_ACTIONS_FQN,
                inputs: {
                    script: func.script,
                },
            },
        },
    }));
}

/**
 * Call the Update App endpoint to set backend function queries on the app definition.
 * PATCH /api/v2/app-builder/apps/{app_builder_id}
 */
async function updateApp(
    appBuilderId: string,
    queries: BackendFunctionQuery[],
    auth: AuthConfig,
    log: Logger,
): Promise<void> {
    const endpoint = `https://api.${auth.site}/api/v2/app-builder/apps/${appBuilderId}`;

    const body = {
        data: {
            type: 'appDefinitions',
            attributes: {
                queries,
            },
        },
    };

    log.debug(`Updating app ${appBuilderId} with ${queries.length} backend function query(ies)`);

    const response = await fetch(endpoint, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'DD-API-KEY': auth.apiKey,
            'DD-APPLICATION-KEY': auth.appKey,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
            `Failed to update app with backend functions (${response.status}): ${errorText}`,
        );
    }

    log.debug(`Successfully updated app ${appBuilderId} with backend function queries`);
}

/**
 * Discover, bundle, transform, and publish backend functions to the app definition.
 * Called after a successful app upload to emulate backend function support.
 */
export async function publishBackendFunctions(
    projectRoot: string,
    backendDir: string,
    appBuilderId: string,
    auth: AuthConfig,
    log: Logger,
): Promise<{ errors: Error[]; warnings: string[] }> {
    const errors: Error[] = [];
    const warnings: string[] = [];

    try {
        const absoluteBackendDir = path.resolve(projectRoot, backendDir);
        const functions = await discoverBackendFunctions(absoluteBackendDir, log);

        if (functions.length === 0) {
            log.debug('No backend functions found, skipping update.');
            return { errors, warnings };
        }

        // Bundle and transform each function
        const transformedFunctions: { name: string; script: string }[] = [];
        for (const func of functions) {
            const bundledCode = await bundleFunction(func, projectRoot, log);
            const script = transformToProductionScript(bundledCode, func.name);
            transformedFunctions.push({ name: func.name, script });
        }

        // Build queries and update the app
        const queries = buildQueries(transformedFunctions);
        await updateApp(appBuilderId, queries, auth, log);

        log.info(
            `Published ${transformedFunctions.length} backend function(s): ${transformedFunctions.map((f) => f.name).join(', ')}`,
        );
    } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push(err);
    }

    return { errors, warnings };
}
