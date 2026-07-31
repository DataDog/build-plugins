// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { addFixtureFiles } from '@dd/tests/_jest/helpers/mocks';
import os from 'os';
import path from 'path';

import { checkFile, outputFileSync, readFilePrefix, rmSync } from './fs';

jest.mock('fs/promises', () => {
    const original = jest.requireActual('fs/promises');
    return {
        ...original,
        stat: jest.fn(),
    };
});

describe('checkFile', () => {
    beforeEach(() => {
        // Emulate some fixtures.
        addFixtureFiles({
            '/fixtures/empty.js': '',
            '/fixtures/not-empty.js': 'Not empty file',
        });
    });

    test.each([
        { filePath: '/fixtures/not-empty.js', expected: { exists: true, empty: false } },
        { filePath: '/fixtures/empty.js', expected: { exists: true, empty: true } },
        { filePath: '/fixtures/not-exist.js', expected: { exists: false, empty: false } },
    ])('Should return "$expected" for the file "$filePath".', async ({ filePath, expected }) => {
        const validity = await checkFile(path.resolve(__dirname, filePath));
        expect(validity).toEqual(expected);
    });
});

describe('readFilePrefix', () => {
    const tempDir = path.join(os.tmpdir(), 'dd-build-plugins-fs-test');

    afterEach(() => {
        rmSync(tempDir);
    });

    test('Should return the whole file when it is smaller than maxBytes.', async () => {
        const filePath = path.join(tempDir, 'small.js');
        outputFileSync(filePath, 'short content');

        const content = await readFilePrefix(filePath, 1024);
        expect(content).toBe('short content');
    });

    test('Should only return the first maxBytes of a file larger than maxBytes.', async () => {
        const filePath = path.join(tempDir, 'large.js');
        outputFileSync(filePath, 'a'.repeat(10_000));

        const content = await readFilePrefix(filePath, 10);
        expect(content).toBe('a'.repeat(10));
    });
});
