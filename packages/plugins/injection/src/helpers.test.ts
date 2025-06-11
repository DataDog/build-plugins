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
    getContentToInject,
} from '@dd/internal-injection-plugin/helpers';
import { mockLogger } from '@dd/tests/_jest/helpers/mocks';
import { vol } from 'memfs';
import nock from 'nock';
import path from 'path';

import { AFTER_INJECTION, BEFORE_INJECTION } from './constants';

jest.mock('fs', () => require('memfs').fs);
jest.mock('fs/promises', () => require('memfs').fs.promises);

const localFileContent = 'local file content';
const distantFileContent = 'distant file content';
const cjsCodeContent = 'module.exports = "cjs code content"';
const esmCodeContent = 'export default "esm code content"';

const codeCjs: ToInjectItem = { type: 'code', value: cjsCodeContent };
const codeEsm: ToInjectItem = { type: 'code', value: esmCodeContent };

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
                ['code', codeCjs],
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
                ['code', { position: InjectPosition.BEFORE, value: cjsCodeContent }],
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
                description: 'basic cjs code',
                expectation: cjsCodeContent,
                item: codeCjs,
            },
            {
                description: 'basic esm code with entryAt',
                expectation: `// Injected code for test:esm-code\n${esmCodeContent}`,
                item: { ...codeEsm, entryAt: 'test:esm-code' },
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
                expectation: cjsCodeContent,
                item: {
                    ...nonExistingDistantFile,
                    fallback: {
                        ...nonExistingFile,
                        fallback: codeCjs,
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

    describe('getContentToInject', () => {
        test.each([
            {
                description: 'cjs code with exports',
                contentToInject: new Map([['codeCjs', codeCjs]]),
                expectation: `${BEFORE_INJECTION}\n(() => {${cjsCodeContent}})();\n${AFTER_INJECTION}`,
            },
            {
                description: 'esm code with exports',
                contentToInject: new Map([['codeEsm', codeEsm]]),
                expectation: `${BEFORE_INJECTION}\n${esmCodeContent}\n${AFTER_INJECTION}`,
            },
            {
                description: 'esm code with entryAt',
                contentToInject: new Map([['codeEsm', { ...codeEsm, entryAt: 'test:esm-code' }]]),
                expectation: `${BEFORE_INJECTION}\n${esmCodeContent}\n${AFTER_INJECTION}`,
            },
            {
                description: 'file content to inject as wrapped function',
                contentToInject: new Map([['existingFile', existingFile]]),
                expectation: `${BEFORE_INJECTION}\n(() => {${existingFile.value}})();\n${AFTER_INJECTION}`,
            },
            {
                description: 'empty type inject as wrapped function',
                contentToInject: new Map([['codeCjs', codeCjs]]),
                expectation: `${BEFORE_INJECTION}\n(() => {${cjsCodeContent}})();\n${AFTER_INJECTION}`,
            },
            {
                description: 'empty content to inject',
                contentToInject: new Map(),
                expectation: '',
            },
        ])(
            'Should get the content to inject for a $description.',
            ({ contentToInject, expectation }) => {
                const result = getContentToInject(contentToInject);
                expect(result).toBe(expectation);
            },
        );
    });
});
