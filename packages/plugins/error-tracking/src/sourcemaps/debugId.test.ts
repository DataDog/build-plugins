// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { extractDebugId } from './debugId';

describe('extractDebugId', () => {
    const debugId = '93fd4850-7b77-4f2e-9aa2-ba013e1a5027';

    test('Should extract the debug ID when the key is quoted (unminified JSON.stringify output)', () => {
        const content = `!function(){}({"service":"app","version":"1.0.0","ddDebugId":"${debugId}"},"DD_SOURCE_CODE_CONTEXT");`;
        expect(extractDebugId(content)).toBe(debugId);
    });

    test('Should extract the debug ID when the key is unquoted (minifiers strip quotes from valid identifier keys)', () => {
        const content = `!function(){}({service:"app",version:"1.0.0",ddDebugId:"${debugId}"},"DD_SOURCE_CODE_CONTEXT");`;
        expect(extractDebugId(content)).toBe(debugId);
    });

    test('Should return undefined when there is no debug ID in the content', () => {
        const content = `!function(){}({service:"app",version:"1.0.0"},"DD_SOURCE_CODE_CONTEXT");`;
        expect(extractDebugId(content)).toBeUndefined();
    });
});
