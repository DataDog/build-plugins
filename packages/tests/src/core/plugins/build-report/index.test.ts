// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    serializeBuildReport,
    unserializeBuildReport,
} from '@dd/core/plugins/build-report/helpers';
import type {
    Input,
    Entry,
    File,
    Options,
    Output,
    BuildReport,
    BundlerReport,
} from '@dd/core/types';
import { outputTexts } from '@dd/telemetry-plugins/common/output/text';
import { defaultDestination, defaultEntry, defaultPluginOptions } from '@dd/tests/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/helpers/runBundlers';
import path from 'path';

// Used to intercept shared contexts.
jest.mock('@dd/telemetry-plugins/common/output/text', () => {
    const originalModule = jest.requireActual('@dd/telemetry-plugins/common/output/text');
    return {
        ...originalModule,
        outputTexts: jest.fn(() => []),
    };
});

// Don't send anything.
jest.mock('@dd/telemetry-plugins/common/sender', () => {
    const originalModule = jest.requireActual('@dd/telemetry-plugins/common/sender');
    return {
        ...originalModule,
        sendMetrics: jest.fn(() => []),
    };
});

const outputTextsMocked = jest.mocked(outputTexts);

const sortFiles = (a: File | Output | Entry, b: File | Output | Entry) => {
    if (a.name < b.name) {
        return -1;
    }
    if (a.name > b.name) {
        return 1;
    }
    return 0;
};

describe('Build Report Plugin', () => {
    describe('Basic build', () => {
        // Intercept contexts to verify it at the moment they're used.
        const bundlerReports: Record<string, BundlerReport> = {};
        const buildReports: Record<string, BuildReport> = {};
        beforeAll(async () => {
            // This one is called at initialization, with the initial context.
            outputTextsMocked.mockImplementation((context) => {
                const bundlerName = `${context.bundler.name}${context.bundler.variant || ''}`;
                // Freeze them in time by deep cloning them safely.
                bundlerReports[bundlerName] = JSON.parse(JSON.stringify(context.bundler));
                buildReports[bundlerName] = unserializeBuildReport(
                    serializeBuildReport(context.build),
                );
            });

            const pluginConfig: Options = {
                ...defaultPluginOptions,
                // TODO: Replace these with an injected custom plugins, once we implemented the feature.
                telemetry: {},
            };

            await runBundlers(pluginConfig);
        });

        const expectedInput = () =>
            expect.objectContaining<Input>({
                name: `src/fixtures/main.js`,
                filepath: require.resolve(defaultEntry),
                dependencies: [],
                dependents: [],
                size: 302,
                type: 'js',
            });

        const expectedOutput = (outDir: string) =>
            expect.objectContaining<Output>({
                name: `main.js`,
                filepath: path.join(outDir, 'main.js'),
                inputs: [
                    expect.objectContaining<Input>({
                        name: `src/fixtures/main.js`,
                        filepath: require.resolve(defaultEntry),
                        dependencies: [],
                        dependents: [],
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
                    const outDir = bundlerReports[name].outDir;
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
                    const outDir = bundlerReports[name].outDir;
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
        const bundlerReports: Record<string, BundlerReport> = {};
        const buildReports: Record<string, BuildReport> = {};
        beforeAll(async () => {
            // Add more entries with more dependencies.
            const entries = {
                app1: '@dd/tests/fixtures/project/main1.js',
                app2: '@dd/tests/fixtures/project/main2.js',
            };

            const bundlerOverrides = {
                rollup: {
                    input: entries,
                },
                vite: {
                    input: entries,
                },
                esbuild: {
                    entryPoints: entries,
                    outdir: path.join(defaultDestination, 'esbuild'),
                },
                webpack5: { entry: entries },
                webpack4: {
                    // Webpack 4 doesn't support pnp.
                    entry: Object.fromEntries(
                        Object.entries(entries).map(([name, filepath]) => [
                            name,
                            `./${path.relative(process.cwd(), require.resolve(filepath))}`,
                        ]),
                    ),
                },
            };

            // TODO: Replace these with an injected custom plugins, once we implemented the feature.
            const pluginConfig: Options = {
                telemetry: {},
            };

            // This one is called at initialization, with the initial context.
            outputTextsMocked.mockImplementation((context) => {
                const bundlerName = `${context.bundler.name}${context.bundler.variant || ''}`;
                // Freeze them in time by deep cloning them safely.
                bundlerReports[bundlerName] = JSON.parse(JSON.stringify(context.bundler));
                buildReports[bundlerName] = unserializeBuildReport(
                    serializeBuildReport(context.build),
                );
            });

            await runBundlers(pluginConfig, bundlerOverrides);
        });

        const expectedInput = (name: string) =>
            expect.objectContaining<Input>({
                name: `src/fixtures/project/${name}.js`,
                filepath: path.join(process.cwd(), `src/fixtures/project/${name}.js`),
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

        const filterOutParticularities = (input: File) =>
            // Vite injects its own preloader helper.
            !input.filepath.includes('vite/preload-helper') &&
            // Exclude ?commonjs-* files, which are coming from the rollup/vite commonjs plugin.
            !input.filepath.includes('?commonjs-') &&
            // Exclude webpack buildin modules, which are webpack internal dependencies.
            !input.filepath.includes('webpack4/buildin');

        describe.each(BUNDLERS)('$name - $version', ({ name }) => {
            describe('Inputs.', () => {
                test('Should be defined and be 15.', () => {
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
                        'src/fixtures/project/main1.js',
                        'src/fixtures/project/main2.js',
                        'src/fixtures/project/src/file0000.js',
                        'src/fixtures/project/src/file0001.js',
                        'src/fixtures/project/workspaces/app/file0000.js',
                        'src/fixtures/project/workspaces/app/file0001.js',
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
                        file.name.startsWith('src/fixtures/project/main'),
                    );

                    expect(entryFiles).toEqual([expectedInput('main1'), expectedInput('main2')]);
                });

                test.each([
                    {
                        filename: 'src/fixtures/project/main1.js',
                        // Main1 imports project files and chalk, which imports all the other third parties.
                        // So it should have all the files of the project + all the third parties.
                        dependencies: [
                            'ansi-styles/index.js',
                            'chalk/index.js',
                            'chalk/templates.js',
                            'color-convert/conversions.js',
                            'color-convert/index.js',
                            'color-convert/route.js',
                            'color-name/index.js',
                            'escape-string-regexp/index.js',
                            'src/fixtures/project/src/file0000.js',
                            'src/fixtures/project/src/file0001.js',
                            'src/fixtures/project/workspaces/app/file0000.js',
                            'src/fixtures/project/workspaces/app/file0001.js',
                            'supports-color/browser.js',
                        ],
                        dependents: [],
                    },
                    {
                        filename: 'src/fixtures/project/main2.js',
                        // Main2 only imports project files.
                        dependencies: [
                            'src/fixtures/project/src/file0000.js',
                            'src/fixtures/project/src/file0001.js',
                            'src/fixtures/project/workspaces/app/file0000.js',
                            'src/fixtures/project/workspaces/app/file0001.js',
                        ],
                        dependents: [],
                    },
                    {
                        filename: 'ansi-styles/index.js',
                        dependencies: [
                            'color-convert/conversions.js',
                            'color-convert/index.js',
                            'color-convert/route.js',
                            'color-name/index.js',
                        ],
                        dependents: ['chalk/index.js', 'src/fixtures/project/main1.js'],
                    },
                    {
                        filename: 'escape-string-regexp/index.js',
                        dependencies: [],
                        dependents: ['chalk/index.js', 'src/fixtures/project/main1.js'],
                    },
                    {
                        filename: 'color-convert/route.js',
                        dependencies: ['color-convert/conversions.js', 'color-name/index.js'],
                        dependents: [
                            'ansi-styles/index.js',
                            'chalk/index.js',
                            'color-convert/index.js',
                            'src/fixtures/project/main1.js',
                        ],
                    },
                    {
                        filename: 'chalk/index.js',
                        // Chalk should have all the third parties as dependencies (except itself).
                        dependencies: [
                            'ansi-styles/index.js',
                            'chalk/templates.js',
                            'color-convert/conversions.js',
                            'color-convert/index.js',
                            'color-convert/route.js',
                            'color-name/index.js',
                            'escape-string-regexp/index.js',
                            'supports-color/browser.js',
                        ],
                        // It should also have a single dependent which is main1.
                        dependents: ['src/fixtures/project/main1.js'],
                    },
                ])(
                    'Should add dependencies and dependents to $filename.',
                    ({ filename, dependencies, dependents }) => {
                        // Sort arrays to have deterministic results.
                        const inputs = buildReports[name]
                            .inputs!.filter(filterOutParticularities)
                            .sort(sortFiles);

                        const file = inputs.find((input) => input.name === filename)!;
                        expect(file.dependencies.map((d) => d.name).sort()).toEqual(dependencies);
                        expect(file.dependents.map((d) => d.name).sort()).toEqual(dependents);
                    },
                );
            });

            describe('Outputs.', () => {
                test('Should be defined.', () => {
                    const outputs = buildReports[name].outputs!;
                    expect(outputs).toBeDefined();
                });

                test('Should have the main outputs.', () => {
                    const outDir = bundlerReports[name].outDir;
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
                    const outDir = bundlerReports[name].outDir;
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
                    const outDir = bundlerReports[name].outDir;
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
                    { entryName: 'app1', dependenciesLength: 9, mainFilesLength: 5 },
                    { entryName: 'app2', dependenciesLength: 0, mainFilesLength: 5 },
                ];

                describe.each(entriesList)(
                    'Entry "$entryName"',
                    ({ entryName, dependenciesLength, mainFilesLength }) => {
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

                            // Based on entry's inputs, we can find the related outputs.
                            const relatedOutputs = outputs
                                .filter((outputFile) => outputFile.type !== 'map')
                                .filter((outputFile) => {
                                    const hasInput = entryInputs.some((inputFile) => {
                                        return outputFile.inputs.some(
                                            (input) => input.name === inputFile.name,
                                        );
                                    });
                                    return hasInput;
                                })
                                .sort(sortFiles);

                            expect(entry.outputs.length).toBeGreaterThan(1);
                            expect(relatedOutputs).toEqual(entry.outputs.sort(sortFiles));
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
});
