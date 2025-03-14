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
import { mockLogger } from '@dd/tests/_jest/helpers/mocks';
import { vol } from 'memfs';
import nock from 'nock';
import path from 'path';

jest.mock('fs', () => require('memfs').fs);
jest.mock('fs/promises', () => require('memfs').fs.promises);

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
        // Emulate some fixtures.
        vol.fromJSON({
            [await getInjectedValue(existingFile)]: localFileContent,
        });
    });

    afterEach(() => {
        vol.reset();
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

            const prom = processInjections(items, mockLogger);
            const expectResult = expect(prom).resolves;

            await expectResult.not.toThrow();

            const results = await prom;
            expect(Array.from(results.entries())).toEqual([
                ['code', { position: InjectPosition.BEFORE, value: codeContent }],
                ['existingFile', { position: InjectPosition.BEFORE, value: localFileContent }],
                [
                    'existingDistantFile',
                    { position: InjectPosition.BEFORE, value: distantFileContent },
                ],
            ]);

            expect(nockScope.isDone()).toBe(true);
        });
    });

    describe('processItem', () => {
        test.each<{ description: string; item: ToInjectItem; expectation: string }>([
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
                expectation: '',
                item: nonExistingFile,
            },
            {
                description: 'an existing distant file',
                expectation: distantFileContent,
                item: existingDistantFile,
            },
            {
                description: 'a non existing distant file',
                expectation: '',
                item: nonExistingDistantFile,
            },
            {
                description: 'failing fallbacks',
                expectation: '',
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
            const expectResult = expect(processItem(item, mockLogger)).resolves;

            await expectResult.not.toThrow();
            await expectResult.toEqual(expectation);
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
            const expectResult = expect(processLocalFile(value)).resolves;

            await expectResult.not.toThrow();
            await expectResult.toEqual(expectation);
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
