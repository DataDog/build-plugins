// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { encodeQueryName } from '@dd/apps-plugin/backend/discovery';

describe('encodeQueryName', () => {
    test('Should produce a hash-based query name', () => {
        const result = encodeQueryName({ path: 'mathUtils', name: 'add' });
        // Should be {12-char hex hash}.{name}
        expect(result).toMatch(/^[0-9a-f]{12}\.add$/);
    });

    test('Should produce consistent names for the same ref', () => {
        const ref = { path: 'src/utils/mathUtils', name: 'multiply' };
        expect(encodeQueryName(ref)).toBe(encodeQueryName(ref));
    });

    test('Should produce different names for different exports of the same file', () => {
        const add = encodeQueryName({ path: 'mathUtils', name: 'add' });
        const multiply = encodeQueryName({ path: 'mathUtils', name: 'multiply' });
        expect(add).not.toBe(multiply);
        // Same hash prefix (same path), different function name suffix
        expect(add.split('.')[0]).toBe(multiply.split('.')[0]);
    });

    test('Should produce different names for different files with the same export', () => {
        const a = encodeQueryName({ path: 'src/a', name: 'handler' });
        const b = encodeQueryName({ path: 'src/b', name: 'handler' });
        expect(a).not.toBe(b);
    });

    test('Should handle paths with slashes', () => {
        const result = encodeQueryName({ path: 'src/features/auth/login', name: 'login' });
        expect(result).toMatch(/^[0-9a-f]{12}\.login$/);
        // Path should not appear in the encoded name
        expect(result).not.toContain('src');
        expect(result).not.toContain('/');
    });
});
