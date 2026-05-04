// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { resolveCjsDefaultExport } from './cjs-interop';

describe('resolveCjsDefaultExport', () => {
    const fn = (ast: unknown, visitor: unknown) => {};

    it('should return the function directly when the import resolved correctly', () => {
        const result = resolveCjsDefaultExport(fn);

        expect(result).toBe(fn);
        expect(typeof result).toBe('function');
    });

    it('should unwrap a double-wrapped default export from bundler interop', () => {
        const doubleWrapped = { default: fn } as unknown as typeof fn;
        const result = resolveCjsDefaultExport(doubleWrapped);

        expect(result).toBe(fn);
        expect(typeof result).toBe('function');
    });

    it('should resolve @babel/traverse to a callable function', () => {
        // This is a smoke test that verifies the actual @babel/traverse
        // import used by the transform module resolves to a function,
        // regardless of the module system's interop behavior.
        const babelTraverse = require('@babel/traverse');
        const traverse = resolveCjsDefaultExport(babelTraverse);

        expect(typeof traverse).toBe('function');
    });
});
