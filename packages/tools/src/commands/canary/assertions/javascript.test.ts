// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, rm } from '@dd/core/helpers/fs';
import os from 'os';
import path from 'path';

import { assertJavaScriptSyntax } from './javascript';

const TEST_ROOT = path.resolve(os.tmpdir(), `build-plugins-canary-javascript-${process.pid}`);

describe('JavaScript canary assertions', () => {
    afterAll(async () => {
        await rm(TEST_ROOT);
    });

    const validCases = [
        {
            description: 'accept an ES module',
            content: 'import { a } from "./a.js"; export const b = await a();',
        },
        {
            description: 'accept a classic script',
            content: '(function () { var self = this; self.ready = true; })();',
        },
    ];

    test.each(validCases)('should $description', async ({ content }) => {
        const filePath = path.resolve(TEST_ROOT, 'valid.js');
        await outputFile(filePath, content);

        await expect(assertJavaScriptSyntax([filePath])).resolves.toBeUndefined();
    });

    const invalidCases = [
        {
            description: 'reject unbalanced braces',
            content: 'function broken() { return 1;',
        },
        {
            description: 'reject duplicate lexical declarations',
            content: 'function duplicate() { let value = 1; let value = 2; return value; }',
        },
    ];

    test.each(invalidCases)('should $description', async ({ content }) => {
        const filePath = path.resolve(TEST_ROOT, 'invalid.js');
        await outputFile(filePath, content);

        await expect(assertJavaScriptSyntax([filePath])).rejects.toThrow(
            `${filePath} is not valid JavaScript`,
        );
    });
});
