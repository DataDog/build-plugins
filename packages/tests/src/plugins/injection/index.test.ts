// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFileSync } from '@dd/core/helpers';
import { InjectPosition, type Options, type ToInjectItem } from '@dd/core/types';
import {
    debugFilesPlugins,
    getComplexBuildOverrides,
    getNodeSafeBuildOverrides,
} from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import type { CleanupFn } from '@dd/tests/_jest/helpers/types';
import { header, licenses } from '@dd/tools/commands/oss/templates';
import { execute } from '@dd/tools/helpers';
import { readFileSync, writeFileSync } from 'fs';
import { glob } from 'glob';
import nock from 'nock';
import path from 'path';

const FAKE_FILE_PREFIX = 'fake-file-to-inject-';

const DOMAIN = 'https://example.com';

enum ContentType {
    CODE = 'code',
    LOCAL = 'local file',
    DISTANT = 'distant file',
}
enum Position {
    BEFORE = 'before',
    MIDDLE = 'middle',
    AFTER = 'after',
}

const getLog = (type: ContentType, position: Position) => {
    const positionString = `in ${position}`;
    const contentString = `Hello injection from ${type}`;
    return `${contentString} ${positionString}.`;
};

const getContent = (type: ContentType, position: Position) => {
    return `console.log("${getLog(type, position)}");`;
};

const getPath = (position: Position) => {
    return `./src/_jest/fixtures${getFileUrl(position)}`;
};

const getFileUrl = (position: Position) => {
    return `/${FAKE_FILE_PREFIX}${position}.js`;
};

describe('Injection Plugin', () => {
    let outdirs: Record<string, string> = {};
    let nockScope: nock.Scope;
    let cleanup: CleanupFn;

    const specialLog: string = 'Hello injection with colors from code in middle.';
    const specialInjection: ToInjectItem = {
        type: 'code',
        value: `import chalk from 'chalk';\nconsole.log(chalk.bold.red('${specialLog}'));\n`,
        position: InjectPosition.MIDDLE,
    };

    const expectations: { type: string; content: string; log: string }[] = [
        // Add a special case of import to confirm this is working as expected in the middle of the code.
        {
            type: '[middle] code injection with imports',
            // Using 'specialLog' here, as imports are probably re-written by the bundlers.
            content: specialLog,
            log: specialLog,
        },
    ];
    const injections: ToInjectItem[] = [specialInjection];

    // Build expectations and mock injections.
    for (const type of Object.values(ContentType)) {
        const injectType = type === ContentType.CODE ? 'code' : 'file';
        for (const position of Object.values(Position)) {
            const positionType =
                position === Position.BEFORE
                    ? InjectPosition.BEFORE
                    : position === Position.MIDDLE
                      ? InjectPosition.MIDDLE
                      : InjectPosition.AFTER;

            expectations.push({
                type: `[${position}] ${type} injection`,
                content: getContent(type, position),
                log: getLog(type, position),
            });

            const injection: ToInjectItem = {
                type: injectType,
                value: getContent(type, position),
                position: positionType,
            };

            if (type === ContentType.DISTANT) {
                injection.value = `${DOMAIN}${getFileUrl(position)}`;
            } else if (type === ContentType.LOCAL) {
                injection.value = getPath(position);
            }

            injections.push(injection);
        }
    }

    // Create a custom plugin to inject the files/codes into the build, store some states and tweak some output.
    const customPlugins: Options['customPlugins'] = (opts, context) => {
        for (const injection of injections) {
            context.inject(injection);
        }

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
            ...debugFilesPlugins(context),
        ];
    };

    // Build the mock files.
    const prepareMocks = () => {
        nockScope = nock(DOMAIN);
        for (const position of Object.values(Position)) {
            // NOTE: These files should already exist and have the correct content.
            // It is just to confirm we keep the same content.
            // We can't use memfs because bundlers, which read the files, runs within "jest.isolateModulesAsync"
            // and don't have access to the same memfs' file system.
            const fileContent = `${header(licenses.mit.name)}\n${getContent(ContentType.LOCAL, position)}`;
            outputFileSync(getPath(position), fileContent);

            // Add mock route to file.
            nockScope
                .get(getFileUrl(position))
                .times(BUNDLERS.length)
                .reply(200, getContent(ContentType.DISTANT, position));
        }
    };

    // Test the environment.
    const testEnv = () => {
        // We have 3 injection positions x 3 types of content + 1 special = 10 expectations.
        expect(expectations).toHaveLength(10);
        expect(injections).toHaveLength(10);

        // We should have called everything we've mocked for.
        expect(nockScope.isDone()).toBe(true);
    };

    const setup = async (overrides: Parameters<typeof runBundlers>[1]) => {
        prepareMocks();
        cleanup = await runBundlers(
            {
                // logLevel: 'error',
                customPlugins,
            },
            overrides,
        );
    };

    const teardown = async () => {
        outdirs = {};
        nock.cleanAll();
        await cleanup();
    };

    describe('Basic build', () => {
        beforeAll(async () => {
            await setup(getNodeSafeBuildOverrides());
        }, 100000);

        afterAll(async () => {
            await teardown();
        });

        test('Should have the correct test environment.', () => {
            testEnv();
        });

        describe.each(BUNDLERS)('$name | $version', ({ name }) => {
            let programOutput: string;
            beforeAll(async () => {
                // Test the actual bundled file too.
                const result = await execute('node', [path.resolve(outdirs[name], 'main.js')]);
                programOutput = result.stdout;
            });

            test.each(expectations)('Should inject "$type" once.', async ({ content, log }) => {
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
        beforeAll(async () => {
            await setup(getNodeSafeBuildOverrides(getComplexBuildOverrides()));
        });

        afterAll(async () => {
            await teardown();
        });

        test('Should have the correct test environment.', () => {
            testEnv();
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

            test.each(expectations)('Should inject "$type".', ({ content, log }) => {
                const files = glob.sync(path.resolve(outdirs[name], '*.{js,mjs}'));
                const fullContent = files.map((file) => readFileSync(file, 'utf8')).join('\n');

                // We don't know exactly how each bundler will concatenate the files.
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
