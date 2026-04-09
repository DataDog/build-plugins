// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Resolve a CJS default export that may be double-wrapped by bundler interop.
 *
 * When a CJS module uses `module.exports = function ...`, ESM `import foo from`
 * should yield the function directly. However, some bundlers (rspack, webpack)
 * wrap the namespace so `foo` is `{ default: fn }` instead of `fn`.
 * This helper normalizes both shapes to the underlying function.
 */
export function resolveCjsDefaultExport<T extends Function>(imported: T | { default: T }): T {
    if (typeof imported === 'function') {
        return imported;
    }
    return imported.default;
}
