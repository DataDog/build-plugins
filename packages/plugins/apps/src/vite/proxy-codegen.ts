// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Generate a proxy module for a backend function.
 *
 * When a frontend file imports a `*.backend.ts` module, Vite serves this
 * generated proxy instead of the real server-side code.  The proxy delegates
 * to `executeBackendFunction` from `@datadog/apps-function-query`, which
 * picks the right transport (dev-server HTTP or iframe postMessage) at runtime.
 */
export function generateProxyModule(functionName: string): string {
    const lines: string[] = [
        `import { executeBackendFunction } from '@datadog/apps-function-query';`,
        '',
        `export async function ${functionName}(...args) {`,
        `    return executeBackendFunction('${functionName}', args);`,
        `}`,
    ];

    return lines.join('\n');
}
