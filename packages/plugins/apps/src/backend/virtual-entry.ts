// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    ACTION_CATALOG_IMPORT,
    SET_EXECUTE_ACTION_SNIPPET,
    isActionCatalogInstalled,
} from './shared';

/**
 * Generate the shared main($) function body lines.
 */
function generateMainBody(functionName: string, argsExpression: string): string[] {
    return [
        '/** @param {import("./context.types").Context} $ */',
        'export async function main($) {',
        '    globalThis.$ = $;',
        '',
        '    // Register the $.Actions-based implementation for executeAction',
        SET_EXECUTE_ACTION_SNIPPET,
        '',
        `    const args = ${argsExpression};`,
        `    const result = await ${functionName}(...args);`,
        '    return result;',
        '}',
    ];
}

/**
 * Generate the virtual entry source for a backend function (production).
 * Uses a template expression resolved at runtime by App Builder.
 */
export function generateVirtualEntryContent(
    functionName: string,
    entryPath: string,
    projectRoot?: string,
): string {
    const lines: string[] = [];

    lines.push(`import { ${functionName} } from ${JSON.stringify(entryPath)};`);

    if (isActionCatalogInstalled(projectRoot)) {
        lines.push(ACTION_CATALOG_IMPORT);
    }

    lines.push('');
    // eslint-disable-next-line no-template-curly-in-string
    lines.push(...generateMainBody(functionName, "JSON.parse('${backendFunctionArgs}' || '[]')"));

    return lines.join('\n');
}
