// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    Input,
    Entry,
    File,
    Options,
    Output,
    BuildReport,
    SerializedInput,
} from '@dd/core/types';
import {
    serializeBuildReport,
    unserializeBuildReport,
} from '@dd/internal-build-report-plugin/helpers';
import { generateProject } from '@dd/tests/_jest/helpers/generateMassiveProject';
import {
    debugFilesPlugins,
    defaultEntry,
    defaultPluginOptions,
    filterOutParticularities,
    getComplexBuildOverrides,
} from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import type {
    BundlerOptionsOverrides,
    CleanupEverythingFn,
    CleanupFn,
} from '@dd/tests/_jest/helpers/types';
import path from 'path';

const sortFiles = (a: File | Output | Entry, b: File | Output | Entry) => {
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
        customPlugins: (opts, context) => [
            {
                name: 'custom-plugin',
                enforce: 'post',
                writeBundle: () => {
                    const bundlerName = context.bundler.fullName;
                    const serializedBuildReport = serializeBuildReport(context.build);

                    // Freeze them in time by deep cloning them safely.
                    bundlerOutdir[bundlerName] = context.bundler.outDir;
                    buildReports[bundlerName] = unserializeBuildReport(serializedBuildReport);
                },
            },
            ...debugFilesPlugins(context),
        ],
        ...overrides,
    };
};

describe('Build Report Plugin', () => {
    describe('Basic build', () => {
        const bundlerOutdir: Record<string, string> = {};
        const buildReports: Record<string, BuildReport> = {};
        let cleanup: CleanupEverythingFn;

        beforeAll(async () => {
            cleanup = await runBundlers(getPluginConfig(bundlerOutdir, buildReports));
        });

        afterAll(async () => {
            await cleanup();
        });

        const expectedInput = () =>
            expect.objectContaining<Input>({
                name: `easy_project/main.js`,
                filepath: path.resolve(cleanup.workingDir, defaultEntry),
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
                        filepath: path.resolve(cleanup.workingDir, defaultEntry),
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
    });

    describe('Complex build', () => {
        // Intercept contexts to verify it at the moment they're used.
        const bundlerOutdir: Record<string, string> = {};
        const buildReports: Record<string, BuildReport> = {};
        let cleanup: CleanupEverythingFn;

        beforeAll(async () => {
            cleanup = await runBundlers(
                getPluginConfig(bundlerOutdir, buildReports),
                getComplexBuildOverrides(),
            );
        });

        afterAll(async () => {
            await cleanup();
        });

        const expectedInput = (name: string) =>
            expect.objectContaining<SerializedInput>({
                name: `hard_project/${name}.js`,
                filepath: path.join(cleanup.workingDir, `hard_project/${name}.js`),
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
                        'supports-color/browser.js',
                    ]);
                });

                test('Should list all third parties.', () => {
                    // Sort arrays to have deterministic results.
                    const inputs = buildReports[name]
                        .inputs!.filter(filterOutParticularities)
                        .sort(sortFiles);

                    // Only list the common dependencies and remove any particularities from bundlers.
                    const thirdParties = inputs!.filter((input) =>
                        input.filepath.includes('node_modules'),
                    );

                    expect(thirdParties.map((d) => d.name).sort()).toEqual([
                        'ansi-styles/index.js',
                        'chalk/index.js',
                        'chalk/templates.js',
                        'color-convert/conversions.js',
                        'color-convert/index.js',
                        'color-convert/route.js',
                        'color-name/index.js',
                        'escape-string-regexp/index.js',
                        'supports-color/browser.js',
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
                            'supports-color/browser.js',
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
                        expect(chunk).toEqual(expectedOutput(chunk.name, outDir));

                        const chunkSourcemap = outputs!.find(
                            (file) => file.name === `${chunk.name}.map`,
                        );
                        expect(chunkSourcemap).toBeDefined();
                        expect(chunkSourcemap).toEqual({
                            name: `${chunk.name}.map`,
                            filepath: path.join(outDir, `${chunk.name}.map`),
                            inputs: [expectedOutput(chunk.name, outDir)],
                            size: expect.any(Number),
                            type: 'map',
                        });
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
                        });

                        test('Should have all the depencencies and the imported files as inputs.', () => {
                            const entries = buildReports[name].entries!;

                            const entry = entries.find(
                                (entryFile) => entryFile.name === entryName,
                            )!;
                            const entryInputs = entry.inputs.filter(filterOutParticularities);
                            const dependencies = entryInputs.filter((input) =>
                                input.filepath.includes('node_modules'),
                            );
                            const mainFiles = entryInputs.filter(
                                (input) => !input.filepath.includes('node_modules'),
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
    describe.skip('Random massive project', () => {
        const bundlerOutdir: Record<string, string> = {};
        const buildReports: Record<string, BuildReport> = {};
        let cleanup: CleanupFn;

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
                webpack5: { mode: 'none', entry: entries },
                webpack4: { mode: 'none', entry: entries },
            };
            cleanup = await runBundlers(
                getPluginConfig(bundlerOutdir, buildReports, { logLevel: 'error', telemetry: {} }),
                bundlerOverrides,
            );
        }, 200000);

        afterAll(async () => {
            await cleanup();
        });

        test('Should generate plenty of modules', () => {
            expect(true).toBe(true);
        });
    });
});
