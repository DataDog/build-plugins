// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFileSync } from '@dd/core/helpers';
import type { Assign, BundlerFullName, Options, ToInjectItem } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import { AFTER_INJECTION, BEFORE_INJECTION } from '@dd/internal-injection-plugin/constants';
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
// Files that we will execute part of the test.
const FILES = ['main.js', 'app1.js', 'app2.js'] as const;
const DOMAIN = 'https://example.com';

type ExpectedValues = [string | RegExp, number | [number, number]];
type BaseExpectation = {
    name: string;
    logs?: Record<File, ExpectedValues>;
    content: ExpectedValues;
};
type EasyExpectation = Assign<BaseExpectation, { logs?: { 'main.js': ExpectedValues } }>;
type HardExpectation = Assign<
    BaseExpectation,
    { logs?: { 'app1.js': ExpectedValues; 'app2.js': ExpectedValues } }
>;
type BuildState = {
    outdir?: string;
    content?: string;
    // Separate logs based on executed file.
    logs?: Partial<Record<File, string>>;
};
type File = (typeof FILES)[number];
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

const getFileUrl = (position: Position) => {
    return `/${FAKE_FILE_PREFIX}${position}.js`;
};

const escapeStringForRegExp = (str: string) =>
    str
        // Escape sensible chars in RegExps.
        .replace(/([().[\]])/g, '\\$1')
        // Replace quotes to allow for both single and double quotes.
        .replace(/["']/g, `(?:"|')`);

describe('Injection Plugin', () => {
    // This is the string we log in our entry files
    // easy_project/src/main.js and hard_project/src/main1.js.
    const normalLog = 'Hello World!';

    // Prepare a special injection where we use imports in MIDDLE.
    const specialLog: string = 'Hello injection with colors from code in middle.';

    // List of expectations for each type of tests.
    const noMarkers: BaseExpectation[] = [
        {
            name: 'No BEFORE_INJECTION markers in easy build',
            content: [BEFORE_INJECTION, 0],
        },
        {
            name: 'No AFTER_INJECTION markers in easy build',
            content: [AFTER_INJECTION, 0],
        },
    ];
    const easyWithoutInjections: EasyExpectation[] = [
        {
            name: 'Normal log in easy build',
            logs: {
                'main.js': [normalLog, 1],
            },
            content: [`console.log("${normalLog}");`, 1],
        },
        ...noMarkers,
    ];
    const hardWithoutInjections: HardExpectation[] = [
        {
            name: 'Normal log in hard build',
            logs: {
                'app1.js': [normalLog, 1],
                'app2.js': [normalLog, 0],
            },
            // Using only normalLog here, as imports and function names (console.log, chalk)
            // are probably re-written and mangled by the bundlers.
            content: [normalLog, 1],
        },
        ...noMarkers,
    ];
    const easyWithInjections: EasyExpectation[] = [
        // We have the same expectation on the normalLog which is not due to injections.
        easyWithoutInjections[0],
        {
            name: '[middle] code injection with imports in easy build',
            logs: {
                'main.js': [specialLog, 1],
            },
            // Using only 'specialLog' here, as imports and function names (console.log, chalk)
            // are probably re-written and mangled by the bundlers.
            content: [specialLog, 1],
        },
    ];
    const hardWithInjections: HardExpectation[] = [
        // We have the same expectation on the normalLog which is not due to injections.
        hardWithoutInjections[0],
        {
            name: '[middle] code injection with imports in hard build',
            logs: {
                'app1.js': [specialLog, 1],
                'app2.js': [specialLog, 1],
            },
            // Using only 'specialLog' here, as imports and function names (console.log, chalk)
            // are probably re-written and mangled by the bundlers.
            // Also, we don't know exactly how each bundler will concatenate the files.
            // Since we have two entries here, we can expect the content
            // to be repeated at least once and at most twice.
            content: [specialLog, [1, 2]],
        },
    ];

    const toInjectItems: ToInjectItem[] = [
        // Add a special case of import to confirm this is working as expected in the middle of the code.
        {
            type: 'code',
            value: `const chalk = require('chalk');\nconsole.log(chalk.bold.red('${specialLog}'));\n`,
            position: InjectPosition.MIDDLE,
        },
    ];

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

            const injectionLog = getLog(type, position);
            const injectionContent = getContent(type, position);
            const injection: ToInjectItem = {
                type: injectType,
                value: injectionContent,
                position: positionType,
            };

            // Fill in the expectations for each type of test.
            hardWithInjections.push({
                name: `[${position}] ${type} injection in hard build`,
                logs: {
                    'app1.js': [injectionLog, 1],
                    'app2.js': [injectionLog, 1],
                },
                content: [injectionContent, [1, 2]],
            });

            easyWithInjections.push({
                name: `[${position}] ${type} injection in easy build`,
                logs: {
                    'main.js': [injectionLog, 1],
                },
                content: [injectionContent, 1],
            });

            if (type === ContentType.DISTANT) {
                injection.value = `${DOMAIN}${getFileUrl(position)}`;
            } else if (type === ContentType.LOCAL) {
                injection.value = `.${getFileUrl(position)}`;
            }

            toInjectItems.push(injection);
        }
    }

    // Create a custom plugin to inject the files/codes into the build, store some states and tweak some output.
    const getPlugins =
        (
            injections: ToInjectItem[] = [],
            buildStates: Partial<Record<BundlerFullName, BuildState>>,
        ): Options['customPlugins'] =>
        (opts, context) => {
            for (const injection of injections) {
                context.inject(injection);
            }

            return [
                {
                    name: 'get-outdirs',
                    writeBundle() {
                        // Store the seeded outdir to inspect the produced files.
                        const buildState: BuildState = buildStates[context.bundler.fullName] || {};
                        buildState.outdir = context.bundler.outDir;
                        buildStates[context.bundler.fullName] = buildState;

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

    // Define our tests.
    const tests: {
        name: string;
        overrides: Parameters<typeof runBundlers>[1];
        positions: Position[];
        injections: [ToInjectItem[], number];
        expectations: (EasyExpectation | HardExpectation)[];
    }[] = [
        {
            name: 'Easy build without injections',
            overrides: (workingDir: string) => getNodeSafeBuildOverrides(workingDir),
            positions: [],
            injections: [[], 0],
            expectations: easyWithoutInjections,
        },
        {
            name: 'Hard build without injections',
            overrides: (workingDir: string) =>
                getNodeSafeBuildOverrides(workingDir, getComplexBuildOverrides()),
            positions: [],
            injections: [[], 0],
            expectations: hardWithoutInjections,
        },
        {
            name: 'Easy build with injections',
            overrides: (workingDir: string) => getNodeSafeBuildOverrides(workingDir),
            positions: Object.values(Position),
            injections: [toInjectItems, 10],
            expectations: easyWithInjections,
        },
        {
            name: 'Hard build with injections',
            overrides: (workingDir: string) =>
                getNodeSafeBuildOverrides(workingDir, getComplexBuildOverrides()),
            positions: Object.values(Position),
            injections: [toInjectItems, 10],
            expectations: hardWithInjections,
        },
    ];

    beforeAll(() => {
        // Prepare mock files.
        for (const position of Object.values(Position)) {
            // NOTE: These files should already exist and have the correct content.
            // It is just to confirm we keep the same content.
            // We can't use memfs because bundlers, which read the files, runs within "jest.isolateModulesAsync"
            // and don't have access to the same memfs' file system.
            const fileContent = `${header(licenses.mit.name)}\n${getContent(ContentType.LOCAL, position)}`;
            outputFileSync(`./src/_jest/fixtures${getFileUrl(position)}`, fileContent);
        }
    });

    describe.each(tests)('$name', ({ overrides, positions, injections, expectations }) => {
        let nockScope: nock.Scope;
        let cleanup: CleanupFn;
        let buildStates: Partial<Record<BundlerFullName, BuildState>> = {};

        beforeAll(async () => {
            nockScope = nock(DOMAIN);

            // Prepare mock routes.
            for (const position of positions) {
                // Add mock route to file.
                nockScope
                    .get(getFileUrl(position))
                    .times(BUNDLERS.length)
                    .reply(200, getContent(ContentType.DISTANT, position));
            }

            cleanup = await runBundlers(
                { customPlugins: getPlugins(injections[0], buildStates) },
                overrides,
            );

            // Execute the builds and store some state.
            const proms: Promise<void>[] = [];
            for (const bundler of BUNDLERS) {
                const buildState = buildStates[bundler.name];
                const outdir = buildState?.outdir;

                // This will be caught in the tests for each bundler.
                if (!outdir || !buildState) {
                    continue;
                }

                const builtFiles = glob.sync(path.resolve(outdir, '*.{js,mjs}'));

                // Only execute files we identified as entries.
                const filesToRun: File[] = builtFiles
                    .map((file) => path.basename(file) as File)
                    .filter((basename) => FILES.includes(basename));

                // Run the files through node to confirm they don't crash and assert their logs.
                proms.push(
                    ...filesToRun.map(async (file) => {
                        const result = await execute('node', [path.resolve(outdir, file)]);
                        buildState.logs = buildState.logs || {};
                        buildState.logs[file] = result.stdout;
                    }),
                );

                // Store the content of the built files to assert the injections.
                buildState.content = builtFiles
                    .map((file) => readFileSync(file, 'utf8'))
                    .join('\n');
            }

            await Promise.all(proms);
            // Webpack can be slow to build...
        }, 100000);

        afterAll(async () => {
            buildStates = {};
            nock.cleanAll();
            await cleanup();
        });

        test('Should have the correct test environment.', () => {
            expect(injections[0]).toHaveLength(injections[1]);

            // We should have called everything we've mocked for.
            expect(nockScope.isDone()).toBe(true);
        });

        describe.each(BUNDLERS)('$name | $version', ({ name }) => {
            let buildState: BuildState;

            test('Should have a buildState.', () => {
                buildState = buildStates[name]!;
                expect(buildState).toBeDefined();
                expect(buildState.outdir).toEqual(expect.any(String));
                expect(buildState.logs).toEqual(expect.any(Object));
                expect(buildState.content).toEqual(expect.any(String));
            });

            describe.each(expectations)(
                '$name',
                ({ content: [expectedContent, contentOccurencies], logs }) => {
                    test('Should have the expected content in the bundles.', () => {
                        const content = buildState.content;
                        const expectation =
                            expectedContent instanceof RegExp
                                ? expectedContent
                                : new RegExp(escapeStringForRegExp(expectedContent));

                        expect(content).toRepeatStringTimes(expectation, contentOccurencies);
                    });

                    if (!logs) {
                        return;
                    }

                    test('Should have output the expected logs from execution.', () => {
                        const logExpectations = Object.entries(logs);
                        for (const [file, [expectedLog, logOccurencies]] of logExpectations) {
                            const stateLogs = buildState.logs?.[file as File];
                            const expectation =
                                expectedLog instanceof RegExp
                                    ? expectedLog
                                    : new RegExp(escapeStringForRegExp(expectedLog));

                            expect(stateLogs).toBeDefined();
                            expect(stateLogs).toRepeatStringTimes(expectation, logOccurencies);
                        }
                    });
                },
            );
        });
    });
});
