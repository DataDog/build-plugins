import type { GlobalContext, Options } from '@dd/core/types';
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

describe('Build Report Plugin', () => {
    describe.only('Basic build', () => {
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
                context.build.outputs!.sort((a, b) => {
                    if (a.name < b.name) {
                        return -1;
                    }
                    if (a.name > b.name) {
                        return 1;
                    }
                    return 0;
                }),
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

        test.each(BUNDLERS)('[$name|$version] List of inputs.', ({ name }) => {
            const context = globalContexts[name];
            expect(context.build.inputs).toHaveLength(1);
            expect(context.build.inputs).toEqual([
                expect.objectContaining({
                    name: `src/fixtures/main.js`,
                    filepath: require.resolve(defaultEntry),
                    size: 302,
                }),
            ]);
        });
    });
});
