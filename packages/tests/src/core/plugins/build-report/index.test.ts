import type { Entry, File, GlobalContext, Options, Output } from '@dd/core/types';
import { output } from '@dd/telemetry-plugins/common/output/index';
import { defaultDestination, defaultEntry, defaultPluginOptions } from '@dd/tests/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/helpers/runBundlers';
import path from 'path';

// Used to intercept shared contexts.
jest.mock('@dd/telemetry-plugins/common/output/index', () => {
    const originalModule = jest.requireActual('@dd/telemetry-plugins/common/output/index');
    return {
        ...originalModule,
        output: jest.fn(() => []),
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

const outputMocked = jest.mocked(output);

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
        const globalContexts: Record<string, GlobalContext> = {};
        beforeAll(async () => {
            // This one is called at initialization, with the initial context.
            outputMocked.mockImplementation((bundlerContext, context, options, log) => {
                const bundlerName = `${context.bundler.name}${context.bundler.variant || ''}`;
                globalContexts[bundlerName] = JSON.parse(JSON.stringify(context));
                return Promise.resolve();
            });

            const pluginConfig: Options = {
                ...defaultPluginOptions,
                // TODO: Replace these with an injected custom plugins, once we implemented the feature.
                telemetry: {},
            };

            await runBundlers(pluginConfig);
        });

        const expectedInput = () =>
            expect.objectContaining({
                name: `src/fixtures/main.js`,
                filepath: require.resolve(defaultEntry),
                size: 302,
                type: 'js',
            });

        const expectedOutput = (outDir: string) =>
            expect.objectContaining({
                name: `main.js`,
                filepath: path.join(outDir, 'main.js'),
                inputs: [
                    expect.objectContaining({
                        name: `src/fixtures/main.js`,
                        filepath: require.resolve(defaultEntry),
                        size: expect.any(Number),
                        type: 'js',
                    }),
                ],
                size: expect.any(Number),
                type: 'js',
            });

        test.each(BUNDLERS)('[$name|$version] List of outputs.', ({ name }) => {
            const context = globalContexts[name];
            const outDir = context.bundler.outDir;

            expect(context.build.outputs).toBeDefined();
            expect(context.build.outputs).toHaveLength(2);

            expect(
                // Sort array to have deterministic results.
                context.build.outputs!.sort(sortFiles),
            ).toEqual([
                expectedOutput(outDir),
                expect.objectContaining({
                    name: `main.js.map`,
                    filepath: path.join(outDir, 'main.js.map'),
                    // Sourcemaps are listing the output file as their input.
                    inputs: [expectedOutput(outDir)],
                    size: expect.any(Number),
                    type: 'map',
                }),
            ]);
        });

        test.each(BUNDLERS)('[$name|$version] List of inputs.', ({ name }) => {
            const context = globalContexts[name];
            expect(context.build.inputs).toHaveLength(1);
            expect(context.build.inputs).toEqual([expectedInput()]);
        });

        test.each(BUNDLERS)('[$name|$version] List of entries.', ({ name }) => {
            const context = globalContexts[name];
            const outDir = context.bundler.outDir;
            expect(context.build.entries).toHaveLength(1);
            expect(context.build.entries).toEqual([
                expect.objectContaining({
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

    describe('Complex build', () => {
        // Intercept contexts to verify it at the moment they're used.
        const globalContexts: Record<string, GlobalContext> = {};
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
            outputMocked.mockImplementation((bundlerContext, context, options, log) => {
                const bundlerName = `${context.bundler.name}${context.bundler.variant || ''}`;
                globalContexts[bundlerName] = JSON.parse(JSON.stringify(context));
                return Promise.resolve();
            });

            await runBundlers(pluginConfig, bundlerOverrides);
        });

        const expectedOutput = (name: string, outDir: string) =>
            expect.objectContaining({
                name,
                filepath: path.join(outDir, name),
                inputs: expect.any(Array),
                size: expect.any(Number),
                type: 'js',
            });

        const filterOutParticularities = (input: File) =>
            // Vite injects its own preloader helper.
            !input.filepath.includes('vite/preload-helper') &&
            // Exclude ?commonjs-* files, which are coming from the rollup/vite commjs plugin
            // and are just commonjs wrappers.
            !input.filepath.includes('?commonjs-') &&
            // Exclude webpack buildin modules, which are webpack internal dependencies.
            !input.filepath.includes('webpack4/buildin');

        test.each(BUNDLERS)('[$name|$version] List of inputs.', ({ name }) => {
            const context = globalContexts[name];

            expect(context.build.inputs).toBeDefined();

            const inputs = context.build.inputs!.filter(filterOutParticularities).sort(sortFiles);
            expect(inputs).toHaveLength(15);

            // Only list the common dependencies and remove any particularities from bundlers.
            const dependencies = inputs.filter((input) => input.filepath.includes('node_modules'));

            expect(dependencies).toHaveLength(9);
            expect(dependencies.map((d) => d.name).sort()).toEqual([
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

        test.only.each(BUNDLERS)('[$name|$version] List of outputs.', ({ name }) => {
            const context = globalContexts[name];
            const outDir = context.bundler.outDir;

            expect(context.build.outputs).toBeDefined();

            const outputs = context.build.outputs!.sort(sortFiles);
            const mainFiles = outputs.filter(
                (file) => !file.name.startsWith('chunk.') && file.type !== 'map',
            );
            const mainSourcemaps = outputs.filter(
                (file) => !file.name.startsWith('chunk.') && file.type === 'map',
            );
            const chunks = outputs.filter(
                (file) => file.name.startsWith('chunk.') && file.type !== 'map',
            );

            expect(mainFiles).toHaveLength(2);
            expect(mainFiles.sort()).toEqual([
                expectedOutput('app1.js', outDir),
                expectedOutput('app2.js', outDir),
            ]);

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

            // Each chunk should have its sourcemaps.
            for (const chunk of chunks) {
                expect(chunk).toEqual(expectedOutput(chunk.name, outDir));

                const chunkSourcemap = outputs.find((file) => file.name === `${chunk.name}.map`);
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
});
