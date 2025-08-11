// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, rm } from '@dd/core/helpers/fs';
import {
    serializeBuildReport,
    unserializeBuildReport,
    debugFilesPlugins,
} from '@dd/core/helpers/plugins';
import { getUniqueId } from '@dd/core/helpers/strings';
import type {
    Input,
    Entry,
    FileReport,
    Options,
    Output,
    BuildReport,
    SerializedInput,
} from '@dd/core/types';
import { prepareWorkingDir } from '@dd/tests/_jest/helpers/env';
import { generateProject } from '@dd/tests/_jest/helpers/generateMassiveProject';
import {
    defaultEntry,
    defaultPluginOptions,
    filterOutParticularities,
    getComplexBuildOverrides,
} from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import type { BundlerOptionsOverrides } from '@dd/tests/_jest/helpers/types';
import path from 'path';
import type { OutputOptions } from 'rollup';

const sortFiles = (a: FileReport | Output | Entry, b: FileReport | Output | Entry) => {
    return a.name.localeCompare(b.name);
};

const getPluginConfig: (
    bundlerOutdir: Record<string, string>,
    buildReports: Record<string, BuildReport>,
    overrides?: Partial<Options>,
) => Options = (bundlerOutdir, buildReports, overrides = {}) => {
    return {
        ...defaultPluginOptions,
        // Use a custom plugin to intercept contexts to verify it at the moment they're used.
        customPlugins: ({ context }) => [
            {
                name: 'custom-plugin',
                bundlerReport: (report) => {
                    const bundlerName = report.name;

                    bundlerOutdir[bundlerName] = report.outDir;
                },
                buildReport: (report) => {
                    // Freeze them in time by deep cloning them safely.
                    const bundlerName = report.bundler.name;
                    const serializedBuildReport = serializeBuildReport(report);
                    buildReports[bundlerName] = unserializeBuildReport(serializedBuildReport);
                },
            },
            ...debugFilesPlugins(context),
        ],
        ...overrides,
    };
};

const isFileThirdParty = (file: Input | Output) => {
    return file.filepath.includes('node_modules') || file.type === 'external';
};

describe('Build Report Plugin', () => {
    describe('Basic build', () => {
        const bundlerOutdir: Record<string, string> = {};
        const buildReports: Record<string, BuildReport> = {};
        const bundlerOutdirMultiOutputs: Record<string, string> = {};
        const buildReportsMultiOutputs: Record<string, BuildReport> = {};
        // We only test multi outputs with vite and rollup,
        // which are the only bundlers offering the feature.
        const multiOutputsBundlers: string[] = BUNDLERS.filter((b) =>
            ['rollup', 'vite'].includes(b.name),
        ).map((b) => b.name);

        // Generate a seed to avoid collision of builds.
        const seed: string = `${Math.abs(jest.getSeed())}.${getUniqueId()}`;
        let workingDir: string;

        beforeAll(async () => {
            workingDir = await prepareWorkingDir(seed);
            // Define 2 separate outputs.
            const getOutputs = (bundler: string): OutputOptions[] => [
                {
                    dir: path.resolve(workingDir, `./dist/${bundler}/multi/cjs`),
                    format: 'cjs',
                    entryFileNames: '[name].cjs',
                    chunkFileNames: 'chunk-[hash].cjs',
                    sourcemap: true,
                },
                {
                    dir: path.resolve(workingDir, `./dist/${bundler}/multi/esm`),
                    format: 'esm',
                    entryFileNames: '[name].mjs',
                    chunkFileNames: 'chunk-[hash].mjs',
                    sourcemap: true,
                },
            ];

            const builds = [];

            for (const bundler of BUNDLERS) {
                // If we're building for multi outputs.
                if (multiOutputsBundlers.includes(bundler.name)) {
                    builds.push(
                        bundler.run(
                            workingDir,
                            getPluginConfig(bundlerOutdirMultiOutputs, buildReportsMultiOutputs),
                            { output: getOutputs(bundler.name) },
                        ),
                    );
                }
                // Normal build.
                builds.push(
                    bundler.run(workingDir, getPluginConfig(bundlerOutdir, buildReports), {}),
                );
            }

            const results = await Promise.all(builds);
            const errors = results.map((result) => result.errors).flat();
            if (errors.length > 0) {
                throw new Error(`Errors found:\n${errors.join('\n')}`);
            }
        });

        afterAll(async () => {
            if (process.env.NO_CLEANUP) {
                // eslint-disable-next-line no-console
                console.log(`[NO_CLEANUP] Working directory: ${workingDir}`);
                return;
            }
            try {
                await rm(workingDir);
            } catch (error) {
                // Ignore errors.
            }
        });

        const expectedInput = () =>
            expect.objectContaining<Input>({
                name: `easy_project/main.js`,
                filepath: path.resolve(workingDir, defaultEntry),
                dependencies: new Set(),
                dependents: new Set(),
                size: 302,
                type: 'js',
            });

        const expectedOutput = (outDir: string) =>
            expect.objectContaining<Output>({
                name: `main.js`,
                filepath: path.join(outDir, 'main.js'),
                inputs: [
                    expect.objectContaining<Input>({
                        name: `easy_project/main.js`,
                        filepath: path.resolve(workingDir, defaultEntry),
                        dependencies: new Set(),
                        dependents: new Set(),
                        size: expect.any(Number),
                        type: 'js',
                    }),
                ],
                size: expect.any(Number),
                type: 'js',
            });

        describe.each(BUNDLERS)('$name - $version', ({ name }) => {
            describe('Outputs', () => {
                test('Should be defined and be 2', () => {
                    const outputs = buildReports[name].outputs!;

                    expect(outputs).toBeDefined();
                    expect(outputs).toHaveLength(2);
                });

                test('Should have the main output and its sourcemap.', () => {
                    const outDir = bundlerOutdir[name];
                    // Sort arrays to have deterministic results.
                    const outputs = buildReports[name].outputs!.sort(sortFiles);

                    expect(outputs).toEqual([
                        expectedOutput(outDir),
                        expect.objectContaining<Output>({
                            name: `main.js.map`,
                            filepath: path.join(outDir, 'main.js.map'),
                            // Sourcemaps are listing the output file as their input.
                            inputs: [expectedOutput(outDir)],
                            size: expect.any(Number),
                            type: 'map',
                        }),
                    ]);

                    // It should have the correct paths for the files.
                    expect(existsSync(path.join(outDir, 'main.js'))).toBeTruthy();
                    expect(existsSync(path.join(outDir, 'main.js.map'))).toBeTruthy();
                });
            });

            describe('Inputs', () => {
                test('Should be defined and be 1', () => {
                    const inputs = buildReports[name].inputs!;

                    expect(inputs).toBeDefined();
                    expect(inputs).toHaveLength(1);
                });

                test('Should have the main input.', () => {
                    const inputs = buildReports[name].inputs!;

                    expect(inputs).toEqual([expectedInput()]);
                });
            });

            describe('Entries', () => {
                test('Should be defined and be 1', () => {
                    const entries = buildReports[name].entries!;

                    expect(entries).toBeDefined();
                    expect(entries).toHaveLength(1);
                });

                test('Should have the main entry.', () => {
                    const outDir = bundlerOutdir[name];
                    // Sort arrays to have deterministic results.
                    const entries = buildReports[name].entries!.sort(sortFiles);

                    expect(entries).toEqual([
                        expect.objectContaining<Entry>({
                            name: 'main',
                            filepath: path.join(outDir, 'main.js'),
                            // The entry should have the entrypoint as input.
                            inputs: [expectedInput()],
                            // And the main output as output.
                            outputs: [expectedOutput(outDir)],
                            size: expect.any(Number),
                            type: 'js',
                        }),
                    ]);
                });
            });
        });

        describe('Multiple outputs', () => {
            describe.each(multiOutputsBundlers)('%s', (bundlerName) => {
                let report: BuildReport;
                let outputs: BuildReport['outputs'];
                let inputs: BuildReport['inputs'];
                let entries: BuildReport['entries'];

                beforeAll(() => {
                    report = buildReportsMultiOutputs[bundlerName]!;
                    outputs = report.outputs!;
                    inputs = report.inputs!;
                    entries = report.entries!;
                });

                test('Should track build report for the bundler', () => {
                    expect(report.bundler.name).toBe(bundlerName);
                });

                test('Should report inputs', () => {
                    expect(inputs).toBeDefined();
                    // We only have one file to build.
                    expect(inputs).toHaveLength(1);
                    expect(inputs).toEqual([
                        {
                            name: 'easy_project/main.js',
                            filepath: path.resolve(workingDir, './easy_project/main.js'),
                            dependencies: new Set(),
                            dependents: new Set(),
                            size: 302,
                            type: 'js',
                        },
                    ]);
                });

                test('Should report entries', () => {
                    expect(entries).toBeDefined();
                    // One entry per output configured, cjs and esm.
                    expect(entries).toHaveLength(2);
                    expect(entries).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({
                                name: 'main',
                                type: 'cjs',
                                filepath: path.resolve(
                                    workingDir,
                                    `./dist/${bundlerName}/multi/cjs/main.cjs`,
                                ),
                                inputs: expect.any(Array),
                                size: expect.any(Number),
                                outputs: expect.any(Array),
                            }),
                            expect.objectContaining({
                                name: 'main',
                                type: 'mjs',
                                filepath: path.resolve(
                                    workingDir,
                                    `./dist/${bundlerName}/multi/esm/main.mjs`,
                                ),
                                inputs: expect.any(Array),
                                size: expect.any(Number),
                                outputs: expect.any(Array),
                            }),
                        ]),
                    );
                });

                test('Should report outputs for both CJS and ESM formats', () => {
                    expect(outputs).toBeDefined();
                    // We have 4 outputs, 2 main files (cjs and esm) and 2 sourcemaps.
                    expect(outputs).toHaveLength(4);
                    const cjsOutputs = outputs!.filter((o) => o.filepath.includes('/cjs/'));
                    const esmOutputs = outputs!.filter((o) => o.filepath.includes('/esm/'));

                    expect(cjsOutputs).toHaveLength(2);
                    expect(esmOutputs).toHaveLength(2);

                    const cjsMain = cjsOutputs.find((o) => o.name === 'main.cjs')!;
                    const esmMain = esmOutputs.find((o) => o.name === 'main.mjs')!;

                    expect(cjsMain).toBeDefined();
                    expect(esmMain).toBeDefined();

                    // It should have the correct paths for the files.
                    expect(existsSync(cjsMain.filepath)).toBeTruthy();
                    expect(existsSync(`${cjsMain.filepath}.map`)).toBeTruthy();
                    expect(existsSync(esmMain.filepath)).toBeTruthy();
                    expect(existsSync(`${esmMain.filepath}.map`)).toBeTruthy();

                    expect(cjsMain.inputs).toHaveLength(1);
                    expect(esmMain.inputs).toHaveLength(1);

                    const cjsInputNames = cjsMain!.inputs.map((i) => i.name).sort();
                    const esmInputNames = esmMain!.inputs.map((i) => i.name).sort();

                    expect(cjsInputNames).toEqual(esmInputNames);
                });
            });
        });
    });

    describe('Complex build', () => {
        // Intercept contexts to verify it at the moment they're used.
        const bundlerOutdir: Record<string, string> = {};
        const buildReports: Record<string, BuildReport> = {};
        let workingDir: string;

        beforeAll(async () => {
            // Mark some dependencies as external to ensure it's correctly reported too.
            const rollupExternals = {
                external: ['supports-color'],
            };
            const xpackExternals = {
                externals: {
                    'supports-color': 'supports-color',
                },
            };
            const result = await runBundlers(
                getPluginConfig(bundlerOutdir, buildReports),
                getComplexBuildOverrides({
                    rollup: rollupExternals,
                    vite: rollupExternals,
                    webpack: xpackExternals,
                    rspack: xpackExternals,
                    esbuild: {
                        external: ['supports-color'],
                    },
                }),
            );
            workingDir = result.workingDir;
        });

        const expectedInput = (name: string) =>
            expect.objectContaining<SerializedInput>({
                name: `hard_project/${name}.js`,
                filepath: path.join(workingDir, `hard_project/${name}.js`),
                dependencies: expect.any(Array),
                dependents: [],
                size: expect.any(Number),
                type: 'js',
            });

        const expectedOutput = (name: string, outDir: string) =>
            expect.objectContaining<Output>({
                name,
                filepath: path.join(outDir, name),
                inputs: expect.any(Array),
                size: expect.any(Number),
                type: 'js',
            });

        describe.each(BUNDLERS)('$name - $version', ({ name }) => {
            describe('Inputs.', () => {
                test('Should be defined.', () => {
                    const inputs = buildReports[name]
                        .inputs!.filter(filterOutParticularities)
                        .sort(sortFiles);
                    expect(inputs).toBeDefined();
                    expect(inputs.map((d) => d.name).sort()).toEqual([
                        'ansi-styles/index.js',
                        'chalk/index.js',
                        'chalk/templates.js',
                        'color-convert/conversions.js',
                        'color-convert/index.js',
                        'color-convert/route.js',
                        'color-name/index.js',
                        'escape-string-regexp/index.js',
                        'hard_project/main1.js',
                        'hard_project/main2.js',
                        'hard_project/src/srcFile0.js',
                        'hard_project/src/srcFile1.js',
                        'hard_project/workspaces/app/workspaceFile0.js',
                        'hard_project/workspaces/app/workspaceFile1.js',
                        'supports-color',
                    ]);
                });

                test('Should list all third parties.', () => {
                    // Sort arrays to have deterministic results.
                    const inputs = buildReports[name]
                        .inputs!.filter(filterOutParticularities)
                        .sort(sortFiles);

                    // Only list the common dependencies and remove any particularities from bundlers.
                    const thirdParties = inputs!.filter((input) => isFileThirdParty(input));

                    expect(thirdParties.map((d) => d.name).sort()).toEqual([
                        'ansi-styles/index.js',
                        'chalk/index.js',
                        'chalk/templates.js',
                        'color-convert/conversions.js',
                        'color-convert/index.js',
                        'color-convert/route.js',
                        'color-name/index.js',
                        'escape-string-regexp/index.js',
                        'supports-color',
                    ]);
                });

                test('Should list the entry files.', () => {
                    // Serialize the build report to be more efficient when assessing.
                    const inputs = serializeBuildReport(buildReports[name])
                        .inputs!.filter(filterOutParticularities)
                        // Sort arrays to have deterministic results.
                        .sort(sortFiles);

                    const entryFiles = inputs.filter((file) =>
                        file.name.startsWith('hard_project/main'),
                    );

                    expect(entryFiles).toEqual([expectedInput('main1'), expectedInput('main2')]);
                });

                test.each([
                    {
                        filename: 'hard_project/main1.js',
                        dependencies: [
                            'chalk/index.js',
                            'hard_project/src/srcFile0.js',
                            'hard_project/workspaces/app/workspaceFile1.js',
                        ],
                        dependents: [],
                    },
                    {
                        filename: 'hard_project/main2.js',
                        dependencies: [
                            'hard_project/src/srcFile0.js',
                            'hard_project/src/srcFile1.js',
                        ],
                        dependents: [],
                    },
                    {
                        filename: 'ansi-styles/index.js',
                        dependencies: ['color-convert/index.js'],
                        dependents: ['chalk/index.js'],
                    },
                    {
                        filename: 'chalk/index.js',
                        // Chalk should have all the third parties as dependencies (except itself).
                        dependencies: [
                            'ansi-styles/index.js',
                            'chalk/templates.js',
                            'escape-string-regexp/index.js',
                            'supports-color',
                        ],
                        // It should also have a single dependent which is main1.
                        dependents: ['hard_project/main1.js'],
                    },
                    {
                        filename: 'color-convert/route.js',
                        dependencies: ['color-convert/conversions.js'],
                        dependents: ['color-convert/index.js'],
                    },
                    {
                        filename: 'color-name/index.js',
                        dependencies: [],
                        dependents: ['color-convert/conversions.js'],
                    },
                    {
                        filename: 'escape-string-regexp/index.js',
                        dependencies: [],
                        dependents: ['chalk/index.js'],
                    },
                ])(
                    'Should add dependencies and dependents to $filename.',
                    ({ filename, dependencies, dependents }) => {
                        // Sort arrays to have deterministic results.
                        const inputs = buildReports[name]
                            .inputs!.filter(filterOutParticularities)
                            .sort(sortFiles);

                        const file = inputs.find((input) => input.name === filename)!;
                        expect(
                            Array.from(file.dependencies)
                                .map((d) => d.name)
                                .sort(),
                        ).toEqual(dependencies);
                        expect(
                            Array.from(file.dependents)
                                .map((d) => d.name)
                                .sort(),
                        ).toEqual(dependents);
                    },
                );
            });

            describe('Outputs.', () => {
                test('Should be defined.', () => {
                    const outputs = buildReports[name].outputs!;
                    expect(outputs).toBeDefined();
                });

                test('Should have the main outputs.', () => {
                    const outDir = bundlerOutdir[name];
                    // Sort arrays to have deterministic results.
                    const outputs = buildReports[name].outputs!.sort(sortFiles);

                    const mainFiles = outputs.filter(
                        (file) => !file.name.startsWith('chunk.') && file.type !== 'map',
                    );

                    expect(mainFiles).toHaveLength(2);
                    expect(mainFiles.sort()).toEqual([
                        expectedOutput('app1.js', outDir),
                        expectedOutput('app2.js', outDir),
                    ]);

                    // It should have the correct paths for the files.
                    expect(existsSync(path.join(outDir, 'app1.js'))).toBeTruthy();
                    expect(existsSync(path.join(outDir, 'app2.js'))).toBeTruthy();
                });

                test('Should have the main sourcemaps.', () => {
                    const outDir = bundlerOutdir[name];
                    // Sort arrays to have deterministic results.
                    const outputs = buildReports[name].outputs!.sort(sortFiles);

                    const mainSourcemaps = outputs!.filter(
                        (file) => !file.name.startsWith('chunk.') && file.type === 'map',
                    );

                    expect(mainSourcemaps).toHaveLength(2);
                    expect(mainSourcemaps.sort(sortFiles)).toEqual([
                        {
                            name: 'app1.js.map',
                            filepath: path.join(outDir, 'app1.js.map'),
                            inputs: [expectedOutput('app1.js', outDir)],
                            size: expect.any(Number),
                            type: 'map',
                        },
                        {
                            name: 'app2.js.map',
                            filepath: path.join(outDir, 'app2.js.map'),
                            inputs: [expectedOutput('app2.js', outDir)],
                            size: expect.any(Number),
                            type: 'map',
                        },
                    ]);

                    // It should have the correct paths for the files.
                    expect(existsSync(path.join(outDir, 'app1.js.map'))).toBeTruthy();
                    expect(existsSync(path.join(outDir, 'app2.js.map'))).toBeTruthy();
                });

                test('Should have the chunks.', () => {
                    const outDir = bundlerOutdir[name];
                    // Sort arrays to have deterministic results.
                    const outputs = buildReports[name].outputs!.sort(sortFiles);

                    const chunks = outputs!.filter(
                        (file) => file.name.startsWith('chunk.') && file.type !== 'map',
                    );

                    // Each chunk should have its sourcemaps.
                    for (const chunk of chunks) {
                        const expectedChunkOutput = expectedOutput(chunk.name, outDir);
                        expect(chunk).toEqual(expectedChunkOutput);

                        const chunkSourcemap = outputs!.find(
                            (file) => file.name === `${chunk.name}.map`,
                        )!;
                        expect(chunkSourcemap).toBeDefined();
                        expect(chunkSourcemap).toEqual({
                            name: `${chunk.name}.map`,
                            filepath: path.join(outDir, `${chunk.name}.map`),
                            inputs: [expectedChunkOutput],
                            size: expect.any(Number),
                            type: 'map',
                        });

                        // It should have the correct paths for the existing files.
                        expect(existsSync(chunk.filepath)).toBeTruthy();
                        expect(existsSync(chunkSourcemap.filepath)).toBeTruthy();
                    }
                });
            });

            describe('Entries.', () => {
                test('Should be defined and be 2.', () => {
                    const entries = buildReports[name].entries!;

                    expect(entries).toBeDefined();
                    expect(entries).toHaveLength(2);
                });

                const entriesList = [
                    { entryName: 'app1', dependenciesLength: 9, mainFilesLength: 4 },
                    { entryName: 'app2', dependenciesLength: 0, mainFilesLength: 5 },
                ];

                describe.each(entriesList)(
                    'Entry "$entryName"',
                    ({ entryName, dependenciesLength, mainFilesLength }) => {
                        test('Should have the correct filepath.', () => {
                            const entries = buildReports[name].entries!;
                            const outDir = bundlerOutdir[name];

                            const entry = entries.find(
                                (entryFile) => entryFile.name === entryName,
                            )!;

                            expect(entry).toBeDefined();
                            expect(entry.filepath).toEqual(path.join(outDir, `${entryName}.js`));

                            // It should have the correct paths for the files.
                            expect(existsSync(entry.filepath)).toBeTruthy();
                        });

                        test('Should have all the depencencies and the imported files as inputs.', () => {
                            const entries = buildReports[name].entries!;

                            const entry = entries.find(
                                (entryFile) => entryFile.name === entryName,
                            )!;
                            const entryInputs = entry.inputs.filter(filterOutParticularities);
                            const dependencies = entryInputs.filter((input) =>
                                isFileThirdParty(input),
                            );
                            const mainFiles = entryInputs.filter(
                                (input) => !isFileThirdParty(input),
                            );

                            expect(dependencies).toHaveLength(dependenciesLength);
                            expect(mainFiles).toHaveLength(mainFilesLength);
                        });

                        test('Should have all the related inputs.', () => {
                            const entries = buildReports[name].entries!;
                            const inputs = buildReports[name].inputs!;

                            const entry = entries.find(
                                (entryFile) => entryFile.name === entryName,
                            )!;

                            // Based on entry's outputs, we can find the related inputs.
                            const relatedInputs = inputs
                                .filter((inputFile) => {
                                    return entry.outputs.some((outputFile) =>
                                        outputFile.inputs.some(
                                            (input) => input.name === inputFile.name,
                                        ),
                                    );
                                })
                                .sort(sortFiles);
                            expect(entry.inputs.length).toBeGreaterThan(1);
                            expect(relatedInputs).toEqual(entry.inputs.sort(sortFiles));
                        });

                        test('Should have all the related outputs.', () => {
                            const entries = buildReports[name].entries!;
                            const outputs = buildReports[name].outputs!;

                            const entry = entries.find(
                                (entryFile) => entryFile.name === entryName,
                            )!;
                            const entryInputs = entry.inputs.filter(filterOutParticularities);

                            // For each inputs of the entry,
                            // we should have at least one output that lists it as input.
                            for (const input of entryInputs) {
                                // In which outputs can we find this input?
                                const inputRelatedOutputs = outputs.filter((output) =>
                                    output.inputs.some(
                                        (inputFile) => inputFile.filepath === input.filepath,
                                    ),
                                );

                                const outputsFound = inputRelatedOutputs.filter((output) =>
                                    entry.outputs.find((o) => o.filepath === output.filepath),
                                );

                                // We should have at least one of these output in our entry.
                                // We sometimes have more outputs than inputs, so we can't be sure.
                                // For instance, esbuild will produce two files for a single input
                                // if it's been async imported and inline imported.
                                expect(outputsFound.length).toBeGreaterThanOrEqual(1);
                            }
                        });

                        test('Should have its size calculated on all outputs it produced.', () => {
                            const entries = buildReports[name].entries!;

                            const entry = entries.find(
                                (entryFile) => entryFile.name === entryName,
                            )!;

                            const size = entry.outputs.reduce(
                                (acc, outputFile) => acc + outputFile.size,
                                0,
                            );

                            expect(entry.size).toEqual(size);
                        });
                    },
                );
            });
        });
    });

    // Kept as .skip to test massive projects with the plugin.
    // eslint-disable-next-line jest/no-disabled-tests
    describe.skip('Random massive project', () => {
        const bundlerOutdir: Record<string, string> = {};
        const buildReports: Record<string, BuildReport> = {};

        beforeAll(async () => {
            const entries = await generateProject(2, 500);
            const bundlerOverrides: BundlerOptionsOverrides = {
                rollup: {
                    input: entries,
                },
                vite: {
                    input: entries,
                },
                esbuild: {
                    entryPoints: entries,
                },
                // Mode production makes the build waaaaayyyyy too slow.
                webpack: { mode: 'none', entry: entries },
            };
            await runBundlers(
                getPluginConfig(bundlerOutdir, buildReports, { logLevel: 'error', metrics: {} }),
                bundlerOverrides,
            );
        }, 200000);

        test('Should generate plenty of modules', () => {
            expect(true).toBe(true);
        });
    });
});
