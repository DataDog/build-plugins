// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options } from '@dd/core/types';
import { getMetrics } from '@dd/telemetry-plugins/common/aggregator';
import type { MetricToSend } from '@dd/telemetry-plugins/types';
import type { Bundler, CleanupFn } from '@dd/tests/helpers/runBundlers';
import { BUNDLERS, runBundlers } from '@dd/tests/helpers/runBundlers';
import path from 'path';

// Used to intercept metrics.
jest.mock('@dd/telemetry-plugins/common/aggregator', () => {
    const originalModule = jest.requireActual('@dd/telemetry-plugins/common/aggregator');
    return {
        ...originalModule,
        getMetrics: jest.fn(),
    };
});

const getMetricsMocked = jest.mocked(getMetrics);

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

const getGetMetricsImplem: (metrics: Record<string, MetricToSend[]>) => typeof getMetrics =
    (metrics) => (context, options, report) => {
        const originalModule = jest.requireActual('@dd/telemetry-plugins/common/aggregator');
        const originalResult = originalModule.getMetrics(context, options, report);
        metrics[context.bundler.fullName] = originalResult;
        return originalResult;
    };

describe('Telemetry Universal Plugin', () => {
    const tracingMetrics = [
        'loaders.count',
        'loaders.duration',
        'loaders.increment',
        'plugins.count',
        'plugins.duration',
        'plugins.hooks.duration',
        'plugins.hooks.increment',
        'plugins.increment',
    ];

    describe('With enableTracing', () => {
        const metrics: Record<string, MetricToSend[]> = {};
        // enableTracing is only supported by esbuild and webpack.
        const activeBundlers = ['esbuild', 'webpack4', 'webpack5'];

        const bundlers = BUNDLERS.filter((bundler) => activeBundlers.includes(bundler.name));
        const expectations: (Bundler & { expectedMetrics: string[] })[] = [];
        const webpack4 = bundlers.find((bundler) => bundler.name === 'webpack4');
        const webpack5 = bundlers.find((bundler) => bundler.name === 'webpack5');
        const esbuild = bundlers.find((bundler) => bundler.name === 'esbuild');

        // Doing it this way to prevent failing when running tests with --bundlers.
        if (esbuild) {
            expectations.push({
                ...esbuild,
                // We only have our own plugin, that is skipped,
                // so we don't have much data, but having this metrics is enough to assert
                // that enableTracing is working.
                expectedMetrics: ['plugins.count'],
            });
        }

        if (webpack4) {
            expectations.push({
                ...webpack4,
                expectedMetrics: tracingMetrics,
            });
        }

        if (webpack5) {
            expectations.push({
                ...webpack5,
                expectedMetrics: tracingMetrics,
            });
        }

        // We don't want to crash if there are no bundlers to test here.
        // Which can happen when using --bundlers.
        if (expectations.length > 0) {
            let cleanup: CleanupFn;

            beforeAll(async () => {
                const pluginConfig: Options = {
                    telemetry: {
                        enableTracing: true,
                        filters: [],
                    },
                    logLevel: 'warn',
                };
                // This one is called at initialization, with the initial context.
                getMetricsMocked.mockImplementation(getGetMetricsImplem(metrics));
                cleanup = await runBundlers(pluginConfig, bundlerOverrides, activeBundlers);
            });

            afterAll(async () => {
                await cleanup();
            });

            test.each(expectations)(
                '$name - $version | Should get the related metrics',
                ({ name, expectedMetrics }) => {
                    const metricNames = metrics[name].map((metric) => metric.metric).sort();
                    expect(metricNames).toEqual(expect.arrayContaining(expectedMetrics));
                },
            );
        }
    });

    describe('Without enableTracing', () => {
        const metrics: Record<string, MetricToSend[]> = {};
        let cleanup: CleanupFn;

        beforeAll(async () => {
            const pluginConfig: Options = {
                telemetry: {
                    filters: [],
                },
                logLevel: 'warn',
            };
            // This one is called at initialization, with the initial context.
            getMetricsMocked.mockImplementation(getGetMetricsImplem(metrics));
            cleanup = await runBundlers(pluginConfig, getComplexBuildOverrides());
        });

        afterAll(async () => {
            await cleanup();
        });

        const getMetric = (
            metricName: string,
            tags: string[] = expect.any(Array),
            // Using expect.any(Number) as each bundler will bundled things differently.
            value: number = expect.any(Number),
        ) => {
            return {
                type: 'gauge',
                tags,
                metric: metricName,
                points: [[expect.any(Number), value]],
            };
        };

        describe.each(BUNDLERS)('$name - $version', ({ name }) => {
            test('Should have no tracing metrics', () => {
                const metricNames = metrics[name].map((metric) => metric.metric).sort();
                expect(metricNames).toEqual(expect.not.arrayContaining(tracingMetrics));
            });

            test('Should have generic metrics', () => {
                expect(metrics[name]).toEqual(
                    expect.arrayContaining([getMetric('modules.count', [], 15)]),
                );
                expect(metrics[name]).toEqual(
                    expect.arrayContaining([getMetric('entries.count', [], 2)]),
                );
                expect(metrics[name]).toEqual(expect.arrayContaining([getMetric('assets.count')]));
                expect(metrics[name]).toEqual(
                    // Rollup and Vite have warnings about circular dependencies, where the others don't.
                    expect.arrayContaining([getMetric('warnings.count')]),
                );
                expect(metrics[name]).toEqual(
                    expect.arrayContaining([getMetric('errors.count', [], 0)]),
                );
                expect(metrics[name]).toEqual(
                    expect.arrayContaining([getMetric('compilation.duration')]),
                );
            });

            test('Should have entry metrics', () => {
                const entryMetrics = metrics[name].filter((metric) =>
                    metric.metric.startsWith('entries'),
                );
                expect(entryMetrics).toEqual(
                    expect.arrayContaining([
                        getMetric('entries.size', ['entryName:app1']),
                        getMetric('entries.modules.count', ['entryName:app1'], 14),
                        getMetric('entries.assets.count', ['entryName:app1']),
                        getMetric('entries.size', ['entryName:app2']),
                        getMetric('entries.modules.count', ['entryName:app2'], 5),
                        getMetric('entries.assets.count', ['entryName:app2']),
                    ]),
                );
            });

            const getAssetMetric = (
                type: string,
                assetName: string,
                entryName: string,
                value: number = expect.any(Number),
            ) => {
                return getMetric(
                    `assets.${type}`,
                    expect.arrayContaining([`assetName:${assetName}`, `entryName:${entryName}`]),
                    value,
                );
            };

            test('Should have asset metrics', () => {
                const assetMetrics = metrics[name].filter((metric) =>
                    metric.metric.startsWith('assets'),
                );

                expect(assetMetrics).toEqual(
                    expect.arrayContaining([getAssetMetric('size', 'app1.js', 'app1')]),
                );
                expect(assetMetrics).toEqual(
                    expect.arrayContaining([getAssetMetric('modules.count', 'app1.js', 'app1')]),
                );
                expect(assetMetrics).toEqual(
                    expect.arrayContaining([getAssetMetric('size', 'app2.js', 'app2')]),
                );
                expect(assetMetrics).toEqual(
                    expect.arrayContaining([getAssetMetric('modules.count', 'app2.js', 'app2')]),
                );
                expect(assetMetrics).toEqual(
                    expect.arrayContaining([getAssetMetric('size', 'app1.js.map', 'app1')]),
                );
                expect(assetMetrics).toEqual(
                    expect.arrayContaining([
                        getAssetMetric('modules.count', 'app1.js.map', 'app1', 1),
                    ]),
                );
                expect(assetMetrics).toEqual(
                    expect.arrayContaining([getAssetMetric('size', 'app2.js.map', 'app2')]),
                );
                expect(assetMetrics).toEqual(
                    expect.arrayContaining([
                        getAssetMetric('modules.count', 'app2.js.map', 'app2', 1),
                    ]),
                );
            });

            const getModuleMetric = (
                type: string,
                moduleName: string,
                entryNames: string[],
                value: number = expect.any(Number),
            ) => {
                return getMetric(
                    `modules.${type}`,
                    expect.arrayContaining([
                        `moduleName:${moduleName}`,
                        `moduleType:js`,
                        ...entryNames.map((entryName) => `entryName:${entryName}`),
                    ]),
                    value,
                );
            };

            // [name, entryNames, size, dependencies, dependents];
            const modulesExpectations: [string, string[], number, number, number][] = [
                ['src/fixtures/project/workspaces/app/file0000.js', ['app1', 'app2'], 30048, 1, 2],
                ['src/fixtures/project/workspaces/app/file0001.js', ['app1', 'app2'], 4549, 1, 2],
                ['src/fixtures/project/src/file0001.js', ['app1', 'app2'], 2203, 2, 2],
                ['src/fixtures/project/src/file0000.js', ['app1', 'app2'], 13267, 2, 2],
                ['escape-string-regexp/index.js', ['app1'], 226, 0, 1],
                ['color-name/index.js', ['app1'], 4617, 0, 1],
                ['color-convert/conversions.js', ['app1'], 16850, 1, 2],
                ['color-convert/route.js', ['app1'], 2227, 1, 1],
                ['color-convert/index.js', ['app1'], 1725, 2, 1],
                ['ansi-styles/index.js', ['app1'], 3574, 1, 1],
                ['supports-color/browser.js', ['app1'], 67, 0, 1],
                ['chalk/templates.js', ['app1'], 3133, 0, 1],
                // Somehow rollup and vite are not reporting the same size.
                // @ts-ignore - Not sure why it doesn't load the new type.
                ['chalk/index.js', ['app1'], expect.toBeWithinRange(6437, 6439), 4, 1],
                ['src/fixtures/project/main1.js', ['app1'], 379, 2, 0],
                ['src/fixtures/project/main2.js', ['app2'], 272, 1, 0],
            ];

            describe.each(modulesExpectations)(
                'Should have module metrics for %s',
                (moduleName, entryNames, size, dependencies, dependents) => {
                    test('Should have module size metrics', () => {
                        const moduleMetrics = metrics[name].filter((metric) =>
                            metric.metric.startsWith('modules'),
                        );

                        expect(moduleMetrics).toEqual(
                            expect.arrayContaining([
                                getModuleMetric('size', moduleName, entryNames, size),
                            ]),
                        );
                    });
                    test('Should have module dependencies metrics', () => {
                        const moduleMetrics = metrics[name].filter((metric) =>
                            metric.metric.startsWith('modules'),
                        );

                        expect(moduleMetrics).toEqual(
                            expect.arrayContaining([
                                getModuleMetric(
                                    'dependencies',
                                    moduleName,
                                    entryNames,
                                    dependencies,
                                ),
                            ]),
                        );
                    });
                    test('Should have module dependents metrics', () => {
                        const moduleMetrics = metrics[name].filter((metric) =>
                            metric.metric.startsWith('modules'),
                        );

                        expect(moduleMetrics).toEqual(
                            expect.arrayContaining([
                                getModuleMetric('dependents', moduleName, entryNames, dependents),
                            ]),
                        );
                    });
                },
            );
        });
    });
});
