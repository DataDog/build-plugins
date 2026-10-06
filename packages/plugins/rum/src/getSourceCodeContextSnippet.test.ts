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

    test.each([0, 7, Infinity])(
        'captures one bundle frame synchronously and restores limit %s',
        (limit) => {
            const context = createContext({ window: {} });
            runInContext(`Error.stackTraceLimit = ${limit}`, context);
            runInContext(`"use strict";${snippet}`, context, {
                filename: 'https://example.com/bundle.js',
            });
            const entries = runInContext('Object.entries(window.DD_SOURCE_CODE_CONTEXT)', context);
            expect(entries).toHaveLength(1);
            expect(entries[0][0]).toMatch(
                /^Error(?:: ?)?\n {4}at https:\/\/example\.com\/bundle\.js:\d+:\d+$/,
            );
            expect(entries[0][1]).toEqual(expectedContext);
            expect(runInContext('Error.stackTraceLimit', context)).toBe(limit);
        },
    );

    test('restores the limit before custom stack formatting runs', () => {
        const context = createContext({ window: {} });
        runInContext(
            `Error.stackTraceLimit = 7; Error.prepareStackTrace = function(error, frames) {
      window.limitDuringFormatting = Error.stackTraceLimit;
      window.frameCount = frames.length;
      return 'custom stack';
    }`,
            context,
        );
        runInContext(snippet, context);
        expect(runInContext('window.limitDuringFormatting', context)).toBe(7);
        expect(runInContext('window.frameCount', context)).toBe(1);
        expect(runInContext('window.DD_SOURCE_CODE_CONTEXT["custom stack"]', context)).toEqual(
            expectedContext,
        );
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

    test('restores the limit when stack formatting fails', () => {
        const context = createContext({ window: {} });
        runInContext(
            `Error.stackTraceLimit = 7;
      Error.prepareStackTrace = function() { throw 'formatting failure'; };`,
            context,
        );
        expect(() => runInContext(snippet, context)).not.toThrow();
        expect(runInContext('Error.stackTraceLimit', context)).toBe(7);
    });

    test('does not add stackTraceLimit on engines without it', () => {
        const context = createContext({ window: {} });
        runInContext(`Error = function() { this.stack = 'unsupported engine stack'; };`, context);
        runInContext(snippet, context);
        expect(runInContext('Object.hasOwn(Error, "stackTraceLimit")', context)).toBe(false);
        expect(
            runInContext('window.DD_SOURCE_CODE_CONTEXT["unsupported engine stack"]', context),
        ).toEqual(expectedContext);
    });

    test('still registers metadata when the limit is read-only in a strict bundle', () => {
        const context = createContext({ window: {} });
        runInContext(
            'Object.defineProperty(Error, "stackTraceLimit", {value: 7, writable: false})',
            context,
        );
        runInContext(`"use strict";${snippet}`, context);
        expect(runInContext('Object.values(window.DD_SOURCE_CODE_CONTEXT)', context)).toEqual([
            expectedContext,
        ]);
        expect(runInContext('Error.stackTraceLimit', context)).toBe(7);
    });

    test('does not access Error in a non-browser environment', () => {
        const context = createContext({});
        runInContext(
            `Object.defineProperty(globalThis, 'Error', {get: function() { throw 'unexpected access'; }})`,
            context,
        );
        expect(() => runInContext(snippet, context)).not.toThrow();
    });
});
