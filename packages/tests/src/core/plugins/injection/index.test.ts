// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options } from '@dd/core/types';
import { getComplexBuildOverrides } from '@dd/tests/helpers/mocks';
import type { CleanupFn } from '@dd/tests/helpers/runBundlers';
import { BUNDLERS, runBundlers } from '@dd/tests/helpers/runBundlers';
import { readFileSync } from 'fs';
import { glob } from 'glob';
import nock from 'nock';
import path from 'path';

describe('Injection Plugin', () => {
    const distantFileContent = 'console.log("Hello injection from distant file.");';
    const localFileContent = 'console.log("Hello injection from local file.");';
    const codeContent = 'console.log("Hello injection from code.");';
    let outdirs: Record<string, string> = {};

    const customPlugins: Options['customPlugins'] = (opts, context) => {
        context.inject({
            type: 'file',
            value: 'https://example.com/distant-file.js',
        });
        context.inject({
            type: 'file',
            value: './src/fixtures/file-to-inject.js',
        });
        context.inject({
            type: 'code',
            value: codeContent,
        });

        return [
            {
                name: 'get-outdirs',
                writeBundle() {
                    // Store the seeded outdir to inspect the produced files.
                    outdirs[context.bundler.fullName] = context.bundler.outDir;
                },
            },
        ];
    };

    describe('Basic build', () => {
        let nockScope: nock.Scope;
        let cleanup: CleanupFn;

        beforeAll(async () => {
            nockScope = nock('https://example.com')
                .get('/distant-file.js')
                .times(BUNDLERS.length)
                .reply(200, distantFileContent);

            cleanup = await runBundlers({
                customPlugins,
            });
        });

        afterAll(async () => {
            outdirs = {};
            nock.cleanAll();
            await cleanup();
        });

        test('Should have requested the distant file for each bundler.', () => {
            expect(nockScope.isDone()).toBe(true);
        });

        describe.each(BUNDLERS)('$name | $version', ({ name }) => {
            test.each([
                { type: 'some string', content: codeContent },
                { type: 'a local file', content: localFileContent },
                { type: 'a distant file', content: distantFileContent },
            ])('Should inject $type once.', ({ content }) => {
                const files = glob.sync(path.resolve(outdirs[name], '*.js'));
                const fullContent = files.map((file) => readFileSync(file, 'utf8')).join('\n');

                // We have a single entry, so the content should be repeated only once.
                expect(fullContent).toRepeatStringTimes(content, 1);
            });
        });
    });

    describe('Complex build', () => {
        let nockScope: nock.Scope;
        let cleanup: CleanupFn;

        beforeAll(async () => {
            nockScope = nock('https://example.com')
                .get('/distant-file.js')
                .times(BUNDLERS.length)
                .reply(200, distantFileContent);

            cleanup = await runBundlers(
                {
                    customPlugins,
                },
                getComplexBuildOverrides(),
            );
        });

        afterAll(async () => {
            outdirs = {};
            nock.cleanAll();
            await cleanup();
        });

        test('Should have requested the distant file for each bundler.', () => {
            expect(nockScope.isDone()).toBe(true);
        });

        describe.each(BUNDLERS)('$name | $version', ({ name }) => {
            test.each([
                { type: 'some string', content: codeContent },
                { type: 'a local file', content: localFileContent },
                { type: 'a distant file', content: distantFileContent },
            ])('Should inject $type.', ({ content }) => {
                const files = glob.sync(path.resolve(outdirs[name], '*.js'));
                const fullContent = files.map((file) => readFileSync(file, 'utf8')).join('\n');

                // We don't know exactly how each bundler will concattenate the files.
                // Since we have two entries here, we can expect the content
                // to be repeated at least once and at most twice.
                expect(fullContent).toRepeatStringRange(content, [1, 2]);
            });
        });
    });
});
