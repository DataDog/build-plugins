// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { InjectPosition, type ToInjectItem } from '@dd/core/types';
import {
    processInjections,
    processItem,
    processLocalFile,
    processDistantFile,
    getInjectedValue,
} from '@dd/internal-injection-plugin/helpers';
import { addFixtureFiles, mockLogger } from '@dd/tests/_jest/helpers/mocks';
import nock from 'nock';
import path from 'path';

jest.mock('@dd/core/helpers/fs', () => {
    const original = jest.requireActual('@dd/core/helpers/fs');
    return {
        ...original,
        readFile: jest.fn(),
    };
});

const localFileContent = 'local file content';
const distantFileContent = 'distant file content';
const codeContent = 'code content';

const code: ToInjectItem = { type: 'code', value: codeContent };
const existingFile: ToInjectItem = { type: 'file', value: 'fixtures/local-file.js' };
const nonExistingFile: ToInjectItem = {
    type: 'file',
    value: 'fixtures/non-existing-file.js',
};
const existingDistantFile: ToInjectItem = {
    type: 'file',
    value: 'https://example.com/distant-file.js',
};
const nonExistingDistantFile: ToInjectItem = {
    type: 'file',
    value: 'https://example.com/non-existing-distant-file.js',
};

describe('Injection Plugin Helpers', () => {
    let nockScope: nock.Scope;

    beforeEach(async () => {
        nockScope = nock('https://example.com')
            .get('/distant-file.js')
            .reply(200, distantFileContent);

        // Add some fixtures.
        addFixtureFiles(
            {
                [await getInjectedValue(existingFile)]: localFileContent,
            },
            process.cwd(),
        );
    });

    describe('processInjections', () => {
        test('Should process injections without throwing.', async () => {
            const items: Map<string, ToInjectItem> = new Map([
                ['code', code],
                ['existingFile', existingFile],
                ['nonExistingFile', nonExistingFile],
                ['existingDistantFile', existingDistantFile],
                ['nonExistingDistantFile', nonExistingDistantFile],
            ]);

            const results = await processInjections(items, mockLogger);
            expect(Array.from(results.entries())).toEqual([
                [
                    'code',
                    {
                        position: InjectPosition.BEFORE,
                        value: codeContent,
                        injectIntoAllChunks: false,
                    },
                ],
                [
                    'existingFile',
                    {
                        position: InjectPosition.BEFORE,
                        value: localFileContent,
                        injectIntoAllChunks: false,
                    },
                ],
                [
                    'existingDistantFile',
                    {
                        position: InjectPosition.BEFORE,
                        value: distantFileContent,
                        injectIntoAllChunks: false,
                    },
                ],
            ]);

            expect(nockScope.isDone()).toBe(true);
        });
    });

    describe('processItem', () => {
        test.each<{ description: string; item: ToInjectItem; expectation?: string }>([
            {
                description: 'basic code',
                expectation: codeContent,
                item: code,
            },
            {
                description: 'an existing file',
                expectation: localFileContent,
                item: existingFile,
            },
            {
                description: 'a non existing file',
                item: nonExistingFile,
            },
            {
                description: 'an existing distant file',
                expectation: distantFileContent,
                item: existingDistantFile,
            },
            {
                description: 'a non existing distant file',
                item: nonExistingDistantFile,
            },
            {
                description: 'failing fallbacks',
                item: {
                    ...nonExistingDistantFile,
                    fallback: nonExistingFile,
                },
            },
            {
                description: 'successful fallbacks',
                expectation: codeContent,
                item: {
                    ...nonExistingDistantFile,
                    fallback: {
                        ...nonExistingFile,
                        fallback: code,
                    },
                },
            },
        ])('Should process $description without throwing.', async ({ item, expectation }) => {
            expect.assertions(1);
            return expect(processItem(item, mockLogger)).resolves.toEqual(expectation);
        });
    });

    describe('processLocalFile', () => {
        test.each([
            {
                description: 'with a relative path',
                value: './fixtures/local-file.js',
                expectation: localFileContent,
            },
            {
                description: 'with an absolute path',
                value: path.join(process.cwd(), './fixtures/local-file.js'),
                expectation: localFileContent,
            },
        ])('Should process local file $description.', async ({ value, expectation }) => {
            expect.assertions(1);
            return expect(processLocalFile(value)).resolves.toEqual(expectation);
        });
    });

    describe('processDistantFile', () => {
        test('Should timeout after a given delay.', async () => {
            nock('https://example.com')
                .get('/delayed-distant-file.js')
                .delay(10)
                .reply(200, 'delayed distant file content');

            await expect(
                processDistantFile('https://example.com/delayed-distant-file.js', 1),
            ).rejects.toThrow('Timeout');
        });
    });
});
