// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    ACTION_CATALOG_IMPORT,
    SET_EXECUTE_ACTION_SNIPPET,
    isActionCatalogInstalled,
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

    lines.push('');
    lines.push('/** @param {import("./context.types").Context} $ */');
    lines.push('export async function main($) {');
    lines.push('    globalThis.$ = $;');
    lines.push('');
    lines.push(`    // Register the $.Actions-based implementation for executeAction`);
    lines.push(SET_EXECUTE_ACTION_SNIPPET);
    lines.push('');
    lines.push('    // backendFunctionArgs is a template expression resolved at runtime by');
    lines.push("    // App Builder's executeBackendFunction client via template_params.");
    // eslint-disable-next-line no-template-curly-in-string
    lines.push("    const args = JSON.parse('${backendFunctionArgs}' || '[]');");
    lines.push(`    const result = await ${functionName}(...args);`);
    lines.push('    return result;');
    lines.push('}');

    return lines.join('\n');
}
