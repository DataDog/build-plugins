// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createContext, runInContext } from 'vm';

import { getSourceCodeContextSnippet } from './getSourceCodeContextSnippet';

describe('source code context runtime registration', () => {
    const { code: snippet, debugId } = getSourceCodeContextSnippet({
        service: 'checkout',
        version: '1.2.3',
        debugId: true,
    });
    const expectedContext = { service: 'checkout', version: '1.2.3', ddDebugId: debugId };

    test('registers one bundle frame synchronously and restores the limit before formatting', () => {
        const context = createContext({ window: {} });
        runInContext(
            `Error.stackTraceLimit = 7;
      Error.prepareStackTrace = function(error, frames) {
        window.limitDuringFormatting = Error.stackTraceLimit;
        return 'Error\\n    at ' + frames.join('\\n    at ');
      };`,
            context,
        );
        runInContext(`"use strict";${snippet}`, context, {
            filename: 'https://example.com/bundle.js',
        });
        const entries = runInContext('Object.entries(window.DD_SOURCE_CODE_CONTEXT)', context);
        expect(entries).toHaveLength(1);
        expect(entries[0][0]).toMatch(/^Error\n {4}at https:\/\/example\.com\/bundle\.js:\d+:\d+$/);
        expect(entries[0][1]).toEqual(expectedContext);
        expect(runInContext('window.limitDuringFormatting', context)).toBe(7);
        expect(runInContext('Error.stackTraceLimit', context)).toBe(7);
    });

    test('restores the limit when error construction fails without breaking the bundle', () => {
        const context = createContext({ window: {} });
        runInContext(
            `var OriginalError = Error; Error = function() { throw new OriginalError('failure'); };
      Error.stackTraceLimit = 7;`,
            context,
        );
        expect(() => runInContext(snippet, context)).not.toThrow();
        expect(runInContext('Error.stackTraceLimit', context)).toBe(7);
    });
});
