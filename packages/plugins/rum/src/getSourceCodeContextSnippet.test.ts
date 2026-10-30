// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { ChunkInfo } from '@dd/core/types';
import { createContext, runInContext } from 'vm';

import { getSourceCodeContextSnippet } from './getSourceCodeContextSnippet';
import type { SourceCodeContextOptions } from './types';

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

describe('source code context version', () => {
    const getChunk = (fileName: string, isInitial: boolean): ChunkInfo => ({
        sourceOrHash: `console.log("${fileName}");`,
        fileName,
        isEntry: isInitial,
        isInitial,
    });
    const initialChunk = getChunk('main.js', true);
    const asyncChunk = getChunk('chunk.js', false);

    // Run the given chunks' snippets, each from its own URL, and return the registered contexts.
    const getRegisteredContexts = (
        options: SourceCodeContextOptions,
        chunks: ChunkInfo[],
    ): unknown[] => {
        const context = createContext({ window: {} });
        for (const chunk of chunks) {
            const { code } = getSourceCodeContextSnippet(options, chunk);
            runInContext(code, context, { filename: `https://example.com/${chunk.fileName}` });
        }
        const serializedContexts = runInContext(
            'JSON.stringify(Object.values(window.DD_SOURCE_CODE_CONTEXT))',
            context,
        );
        return JSON.parse(serializedContexts);
    };

    const cases: {
        description: string;
        options: SourceCodeContextOptions;
        chunk: ChunkInfo;
        expected: { version?: string };
    }[] = [
        {
            description: 'keep the version in async chunks by default',
            options: { debugId: true, version: '1.2.3' },
            chunk: asyncChunk,
            expected: { version: '1.2.3' },
        },
        {
            description: 'omit the version from async chunks when asked',
            options: { debugId: true, version: '1.2.3', omitVersionFromAsyncChunks: true },
            chunk: asyncChunk,
            expected: {},
        },
        {
            description: 'keep the version in initial chunks when asked to omit it from async ones',
            options: { debugId: true, version: '1.2.3', omitVersionFromAsyncChunks: true },
            chunk: initialChunk,
            expected: { version: '1.2.3' },
        },
        {
            description: 'keep the version of a context with a service',
            options: {
                debugId: true,
                service: 'checkout',
                version: '1.2.3',
                omitVersionFromAsyncChunks: true,
            },
            chunk: asyncChunk,
            expected: { version: '1.2.3' },
        },
    ];

    test.each(cases)('should $description', ({ options, chunk, expected }) => {
        const [registeredContext] = getRegisteredContexts(options, [chunk]);

        expect(registeredContext).toEqual({
            ...(options.service ? { service: options.service } : {}),
            ...expected,
            ddDebugId: expect.any(String),
        });
    });

    test('should not depend on the version in async chunks when asked', () => {
        const firstBuild = getSourceCodeContextSnippet(
            { debugId: true, version: '1.0.0', omitVersionFromAsyncChunks: true },
            asyncChunk,
        );
        const secondBuild = getSourceCodeContextSnippet(
            { debugId: true, version: '2.0.0', omitVersionFromAsyncChunks: true },
            asyncChunk,
        );

        expect(secondBuild.code).toBe(firstBuild.code);
    });

    test('should register the version for the initial chunk only when asked', () => {
        const options: SourceCodeContextOptions = {
            debugId: true,
            version: '1.2.3',
            omitVersionFromAsyncChunks: true,
        };
        const contexts = getRegisteredContexts(options, [initialChunk, asyncChunk]);

        expect(contexts).toEqual([
            { version: '1.2.3', ddDebugId: expect.any(String) },
            { ddDebugId: expect.any(String) },
        ]);
    });
});
