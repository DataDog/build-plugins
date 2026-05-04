// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

interface ProxyExport {
    /** The JS export name (e.g. "add") */
    exportName: string;
    /** The pre-computed opaque query name (e.g. "a1b2c3d4e5f6.add") */
    queryName: string;
}

/**
 * Generate a proxy module for a `.backend.ts` file. Each exported function
 * is replaced with a wrapper that calls `executeBackendFunction` from the
 * runtime exposed on `globalThis.DD_APPS_RUNTIME` by the apps plugin's
 * injection (see packages/plugins/apps/src/built/apps-runtime.ts).
 *
 * The raw backend file path is never present in the generated code — only
 * the hashed query name appears, preventing backend file structure from
 * leaking into frontend bundles.
 *
 * @param exports - The export name + pre-computed query name for each export
 * @returns Generated proxy module source code
 */
export function generateProxyModule(exports: ProxyExport[]): string {
    const lines: string[] = [];

    for (const { exportName, queryName } of exports) {
        lines.push(`export async function ${exportName}(...args) {`);
        lines.push(
            `    return globalThis.DD_APPS_RUNTIME.executeBackendFunction(${JSON.stringify(queryName)}, args);`,
        );
        lines.push('}');
        lines.push('');
    }

    return lines.join('\n');
}
