// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { stringToUUID, getSnippet, getDebugIdFromSource } from './utils';

const UUID_RX = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

describe('stringToUUID', () => {
    test('should produce a valid UUID v4 format', () => {
        expect(stringToUUID('hello')).toMatch(UUID_RX);
    });

    test('should be deterministic for the same input', () => {
        expect(stringToUUID('hello')).toBe(stringToUUID('hello'));
    });

    test('should differ for different inputs', () => {
        expect(stringToUUID('hello')).not.toBe(stringToUUID('world'));
    });
});

describe('getSnippet', () => {
    const uuid = '12345678-1234-4234-8234-123456789abc';

    test('should include the UUID in the output', () => {
        expect(getSnippet(uuid)).toContain(uuid);
    });

    test('should assign to DD_DEBUG_IDS global', () => {
        expect(getSnippet(uuid)).toContain('DD_DEBUG_IDS');
    });

    test('should be a single line (no newlines)', () => {
        expect(getSnippet(uuid)).not.toContain('\n');
    });

    test('should pass the UUID and variable name as IIFE arguments', () => {
        expect(getSnippet(uuid)).toContain(`})("${uuid}","DD_DEBUG_IDS")`);
    });

    test('should guard on window before accessing it', () => {
        expect(getSnippet(uuid)).toContain("typeof window==='undefined'");
    });
});

describe('getDebugIdFromSource', () => {
    const uuid = '12345678-1234-4234-8234-123456789abc';

    test('should round-trip the UUID injected by getSnippet', () => {
        const source = `${getSnippet(uuid)}\nconsole.log('app');`;
        expect(getDebugIdFromSource(source)).toBe(uuid);
    });

    test('should recover the UUID from a minified single-quote variant', () => {
        const minified = `})('${uuid}','DD_DEBUG_IDS')`;
        expect(getDebugIdFromSource(minified)).toBe(uuid);
    });

    test('should return undefined when no UUID is present', () => {
        expect(getDebugIdFromSource('console.log("no debug id here");')).toBeUndefined();
    });

    test('should not match a stray UUID unrelated to DD_DEBUG_IDS', () => {
        expect(getDebugIdFromSource(`var id="${uuid}";`)).toBeUndefined();
    });
});
