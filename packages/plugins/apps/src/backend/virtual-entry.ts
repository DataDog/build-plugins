// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    ACTION_CATALOG_IMPORT,
    APPS_BACKEND_RUNTIME_IMPORTS,
    SET_APPS_BACKEND_RUNTIME_SNIPPET,
    SET_EXECUTE_ACTION_SNIPPET,
    isActionCatalogInstalled,
    isAppsBackendRuntimeInstalled,
} from './shared';

/**
 * Generate the virtual entry source for a backend function.
 * The host bundler resolves imports, so no export-stripping is needed.
 */
export function generateVirtualEntryContent(
    functionName: string,
    entryPath: string,
    projectRoot: string,
): string {
    const lines: string[] = [];

    lines.push(`import { ${functionName} } from ${JSON.stringify(entryPath)};`);

    if (isActionCatalogInstalled(projectRoot)) {
        lines.push(ACTION_CATALOG_IMPORT);
    }

    const hasAppsBackendRuntime = isAppsBackendRuntimeInstalled(projectRoot);
    if (hasAppsBackendRuntime) {
        lines.push(APPS_BACKEND_RUNTIME_IMPORTS);
    }

    lines.push('');
    lines.push('/** @param {import("./context.types").Context} $ */');
    lines.push('export async function main($) {');
    lines.push('    globalThis.$ = $;');
    lines.push('');
    if (hasAppsBackendRuntime) {
        lines.push('    // Install the backend API implementation for this invocation');
        lines.push(SET_APPS_BACKEND_RUNTIME_SNIPPET);
        lines.push('');
    }
    lines.push(`    // Register the $.Actions-based implementation for executeAction`);
    lines.push(SET_EXECUTE_ACTION_SNIPPET);
    lines.push('');
    lines.push('    const args = $.backendFunctionArgs ?? [];');
    lines.push(`    const result = await ${functionName}(...args);`);
    lines.push('    return result;');
    lines.push('}');

    return lines.join('\n');
}

/**
 * Generate the virtual entry source for a backend function (dev server).
 * Identical to production: args are read from $.backendFunctionArgs at runtime.
 */
export function generateDevVirtualEntryContent(
    functionName: string,
    entryPath: string,
    projectRoot?: string,
): string {
    return generateVirtualEntryContent(functionName, entryPath, projectRoot ?? process.cwd());
}
