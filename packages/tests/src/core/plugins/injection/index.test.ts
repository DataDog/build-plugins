// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options } from '@dd/core/types';
import { getComplexBuildOverrides, getNodeSafeBuildOverrides } from '@dd/tests/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/helpers/runBundlers';
import type { CleanupFn } from '@dd/tests/helpers/types';
import { execute } from '@dd/tools/helpers';
import { readFileSync, writeFileSync } from 'fs';
import { glob } from 'glob';
import nock from 'nock';
import path from 'path';

describe('Injection Plugin', () => {
    const distantFileLog = 'Hello injection from distant file.';
    const distantFileContent = `console.log("${distantFileLog}");`;
    const localFileLog = 'Hello injection from local file.';
    const localFileContent = `console.log("${localFileLog}");`;
    const codeLog = 'Hello injection from code.';
    const codeContent = `console.log("${codeLog}");`;
    let outdirs: Record<string, string> = {};

    const expectations = [
        { type: 'some string', content: codeContent, log: codeLog },
        { type: 'a local file', content: localFileContent, log: localFileLog },
        { type: 'a distant file', content: distantFileContent, log: distantFileLog },
    ];

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

                    // Add a package.json file to the esm builds.
                    if (['esbuild'].includes(context.bundler.fullName)) {
                        writeFileSync(
                            path.resolve(context.bundler.outDir, 'package.json'),
                            '{ "type": "module" }',
                        );
                    }
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

            cleanup = await runBundlers(
                {
                    customPlugins,
                },
                getNodeSafeBuildOverrides(),
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
            let programOutput: string;
            beforeAll(async () => {
                // Test the actual bundled file too.
                const result = await execute('node', [path.resolve(outdirs[name], 'main.js')]);
                programOutput = result.stdout;
            });

            test.each(expectations)('Should inject $type once.', async ({ content, log }) => {
                const files = glob.sync(path.resolve(outdirs[name], '*.{js,mjs}'));
                const fullContent = files.map((file) => readFileSync(file, 'utf8')).join('\n');

                // We have a single entry, so the content should be repeated only once.
                expect(fullContent).toRepeatStringTimes(content, 1);
                // Verify the program output from the bundled project.
                expect(programOutput).toRepeatStringTimes(log, 1);
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
                getNodeSafeBuildOverrides(getComplexBuildOverrides()),
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
            let programOutput1: string;
            let programOutput2: string;
            beforeAll(async () => {
                // Test the actual bundled file too.
                const result1 = await execute('node', [path.resolve(outdirs[name], 'app1.js')]);
                programOutput1 = result1.stdout;
                const result2 = await execute('node', [path.resolve(outdirs[name], 'app2.js')]);
                programOutput2 = result2.stdout;
            });

            test.each(expectations)('Should inject $type.', ({ content, log }) => {
                const files = glob.sync(path.resolve(outdirs[name], '*.{js,mjs}'));
                const fullContent = files.map((file) => readFileSync(file, 'utf8')).join('\n');

                // We don't know exactly how each bundler will concattenate the files.
                // Since we have two entries here, we can expect the content
                // to be repeated at least once and at most twice.
                expect(fullContent).toRepeatStringRange(content, [1, 2]);
                // Verify the program output from the bundled project.
                expect(programOutput1).toRepeatStringTimes(log, 1);
                expect(programOutput2).toRepeatStringTimes(log, 1);
            });
        });
    });
});
