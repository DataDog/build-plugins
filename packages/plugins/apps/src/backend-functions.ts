// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import * as esbuild from 'esbuild';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import type { Asset } from './assets';
import {
    ACTION_CATALOG_EXPORT_LINE,
    NODE_EXTERNALS,
    SET_EXECUTE_ACTION_SNIPPET,
    isActionCatalogInstalled,
} from './backend-shared';

export interface BackendFunction {
    name: string;
    entryPath: string;
}

const EXTENSIONS = ['.ts', '.js', '.tsx', '.jsx'];

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
 * Build the stdin contents for esbuild bundling.
 * Only forces action-catalog into the bundle if it is installed.
 */
function buildStdinContents(filePath: string): string {
    const lines = [`export * from ${JSON.stringify(filePath)};`];

    if (isActionCatalogInstalled()) {
        lines.push(ACTION_CATALOG_EXPORT_LINE);
    }

    return lines.join('\n');
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
                contents: buildStdinContents(func.entryPath),
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
${SET_EXECUTE_ACTION_SNIPPET}

    const args = JSON.parse('\${backendFunctionArgs}' || '[]');
    const result = await ${functionName}(...args);
    return result;
}`;

    return scriptBody;
}

/**
 * Discover, bundle, and transform backend functions for inclusion in the upload archive.
 * Writes transformed scripts to temp files and returns file references for archiving.
 */
export async function bundleBackendFunctions(
    projectRoot: string,
    backendDir: string,
    log: Logger,
): Promise<{ files: Asset[]; tempDir: string }> {
    const absoluteBackendDir = path.resolve(projectRoot, backendDir);
    const functions = await discoverBackendFunctions(absoluteBackendDir, log);

    if (functions.length === 0) {
        log.debug('No backend functions found.');
        return { files: [], tempDir: '' };
    }

    const tempDir = path.join(tmpdir(), `dd-apps-backend-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    const files: Asset[] = [];
    for (const func of functions) {
        const bundledCode = await bundleFunction(func, projectRoot, log);
        const script = transformToProductionScript(bundledCode, func.name);
        const absolutePath = path.join(tempDir, `${func.name}.js`);
        await writeFile(absolutePath, script, 'utf-8');
        files.push({ absolutePath, relativePath: `backend/${func.name}.js` });
    }

    log.info(
        `Bundled ${files.length} backend function(s): ${functions.map((f) => f.name).join(', ')}`,
    );

    return { files, tempDir };
}
