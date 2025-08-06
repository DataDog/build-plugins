// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { debugFilesPlugins } from '@dd/core/helpers/plugins';
import type { Options, Metric } from '@dd/core/types';
import { getMetricsToSend } from '@dd/metrics-plugin/common/helpers';
import { getPlugins } from '@dd/metrics-plugin';
import {
    FAKE_SITE,
    getComplexBuildOverrides,
    getGetPluginsArg,
} from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import type { Bundler } from '@dd/tests/_jest/helpers/types';
import nock from 'nock';

import { METRICS_API_PATH } from './common/sender';

// Used to intercept metrics.
jest.mock('@dd/metrics-plugin/common/helpers', () => {
    const originalModule = jest.requireActual('@dd/metrics-plugin/common/helpers');
    return {
        ...originalModule,
        getMetricsToSend: jest.fn(),
    };
});

const getMetricsToSendMocked = jest.mocked(getMetricsToSend);

const getMetricsToSendImplem: (store: Record<string, Metric[]>) => typeof getMetricsToSend =
    (store) => (metrics, timestamp, filters, defaultTags, prefix) => {
        const originalModule = jest.requireActual<
            typeof import('@dd/metrics-plugin/common/helpers')
        >('@dd/metrics-plugin/common/helpers');

        const metricsToSend = originalModule.getMetricsToSend(
            metrics,
            timestamp,
            filters,
            defaultTags,
            prefix,
        );

        const bundlerName = prefix.split('.').pop()!;
        store[bundlerName] = Array.from(metricsToSend);

        return metricsToSend;
    };

const getUniqueMetricsNames = (metrics: Metric[]) => {
    return Array.from(new Set(metrics.map((metric) => metric.metric))).sort();
};

const prefixMetricsNames = (metricsNames: string[], bundlerName: string) => {
    return metricsNames.map((m) => prefixMetricsName(m, bundlerName));
};

const prefixMetricsName = (metricsName: string, bundlerName: string) => {
    return `build.${bundlerName}.${metricsName}`;
};

describe('Metrics Universal Plugin', () => {
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

    const genericMetrics = [
        'assets.count',
        'assets.modules.count',
        'assets.size',
        'compilation.duration',
        'entries.assets.count',
        'entries.count',
        'entries.modules.count',
        'entries.size',
        'errors.count',
        'metrics.count',
        'modules.count',
        'modules.dependencies',
        'modules.dependents',
        'modules.size',
        'warnings.count',
    ];

    beforeAll(() => {
        nock(`https://${FAKE_SITE}`)
            .persist()
            // Intercept metrics submissions.
            .post(`/${METRICS_API_PATH}?api_key=123`)
            .reply(200, {});
    });

    afterAll(async () => {
        nock.cleanAll();
    });

    describe('getPlugins', () => {
        test('Should not initialize the plugin if not enabled', async () => {
            expect(getPlugins(getGetPluginsArg({ metrics: { enable: false } }))).toHaveLength(0);
            expect(getPlugins(getGetPluginsArg())).toHaveLength(0);
        });

        test('Should initialize the plugin if enabled', async () => {
            expect(
                getPlugins(getGetPluginsArg({ metrics: { enable: true } })).length,
            ).toBeGreaterThan(0);
        });
    });

    describe('With enableTracing', () => {
        const metrics: Record<string, Metric[]> = {};
        // enableTracing is only supported by esbuild and webpack.
        const activeBundlers = ['esbuild', 'webpack', 'rspack'];

        const bundlers = BUNDLERS.filter((bundler) => activeBundlers.includes(bundler.name));
        const expectations: (Bundler & { expectedMetrics: string[] })[] = [];
        const webpack = bundlers.find((bundler) => bundler.name === 'webpack');
        const esbuild = bundlers.find((bundler) => bundler.name === 'esbuild');
        const rspack = bundlers.find((bundler) => bundler.name === 'rspack');

        // Doing it this way to prevent failing when running tests with --bundlers.
        if (esbuild) {
            expectations.push({
                ...esbuild,
                // We only have our own plugin enabled, esbuild's plugin can't capture itself,
                // so we don't have much data, but having these metrics is enough to assert
                // that enableTracing is working.
                expectedMetrics: ['loaders.count', 'plugins.count', ...genericMetrics],
            });
        }

        if (webpack) {
            expectations.push({
                ...webpack,
                expectedMetrics: [...tracingMetrics, ...genericMetrics],
            });
        }

        if (rspack) {
            expectations.push({
                ...rspack,
                expectedMetrics: [...tracingMetrics, ...genericMetrics],
            });
        }

        // We don't want to crash if there are no bundlers to test here.
        // Which can happen when using --bundlers.
        if (!expectations.length) {
            return;
        }

        beforeAll(async () => {
            const pluginConfig: Options = {
                auth: { site: FAKE_SITE },
                metrics: {
                    enableTracing: true,
                    filters: [],
                },
                logLevel: 'warn',
                customPlugins: ({ context }) => debugFilesPlugins(context),
            };
            // This one is called at initialization, with the initial context.
            getMetricsToSendMocked.mockImplementation(getMetricsToSendImplem(metrics));
            await runBundlers(pluginConfig, getComplexBuildOverrides(), activeBundlers);
        });

        test.each(expectations)(
            '$name - $version | Should get the related metrics',
            ({ name, expectedMetrics }) => {
                const metricNames = getUniqueMetricsNames(metrics[name]);
                expect(metricNames).toEqual(prefixMetricsNames(expectedMetrics, name).sort());
            },
        );
    });

    describe('Without enableTracing', () => {
        const metrics: Record<string, Metric[]> = {};

        beforeAll(async () => {
            const pluginConfig: Options = {
                auth: { site: FAKE_SITE },
                metrics: {
                    filters: [],
                },
                logLevel: 'warn',
                customPlugins: ({ context }) => debugFilesPlugins(context),
            };
            // This one is called at initialization, with the initial context.
            getMetricsToSendMocked.mockImplementation(getMetricsToSendImplem(metrics));
            await runBundlers(pluginConfig, getComplexBuildOverrides());
        });

        const getMetric = (
            metricName: string,
            tags: string[] = expect.any(Array),
            // Using expect.any(Number) as each bundler will bundled things differently.
            value: number = expect.any(Number),
        ) => {
            return {
                tags,
                metric: metricName,
                points: [[expect.any(Number), value]],
            };
        };

        type GetMetricParams = Parameters<typeof getMetric>;

        describe.each(BUNDLERS)('$name - $version', ({ name }) => {
            test('Should have all the expected metrics without any tracing metrics', () => {
                const metricNames = getUniqueMetricsNames(metrics[name]);
                expect(metricNames).toEqual(prefixMetricsNames(genericMetrics, name));
            });

            describe('Generic metrics', () => {
                const genericMetricsExpectations: {
                    metric: string;
                    args: [GetMetricParams[1]?, GetMetricParams[2]?];
                }[] = [
                    { metric: 'modules.count', args: [[], 15] },
                    { metric: 'entries.count', args: [[], 2] },
                    // Each bundler may have its own way of bundling.
                    { metric: 'assets.count', args: [] },
                    // Rollup and Vite have warnings about circular dependencies, where the others don't.
                    { metric: 'warnings.count', args: [] },
                    { metric: 'errors.count', args: [[], 0] },
                    { metric: 'compilation.duration', args: [] },
                ];

                test.each(genericMetricsExpectations)('Should have $metric', ({ metric, args }) => {
                    const metricToTest = getMetric(metric, ...args);
                    const foundMetrics = metrics[name].filter(
                        (m) => m.metric === prefixMetricsName(metricToTest.metric, name),
                    );

                    expect(foundMetrics).toHaveLength(1);
                    expect(foundMetrics[0]).toEqual({
                        ...metricToTest,
                        type: foundMetrics[0].type,
                        metric: `build.${name}.${metricToTest.metric}`,
                    });
                });
            });

            describe('Entry metrics', () => {
                test.each([
                    { metric: 'entries.size', tags: ['entryName:app1'] },
                    { metric: 'entries.modules.count', tags: ['entryName:app1'] },
                    { metric: 'entries.assets.count', tags: ['entryName:app1'] },
                    { metric: 'entries.size', tags: ['entryName:app2'] },
                    { metric: 'entries.modules.count', tags: ['entryName:app2'] },
                    { metric: 'entries.assets.count', tags: ['entryName:app2'] },
                ])('Should have $metric with $tags', ({ metric, tags }) => {
                    const entryMetrics = metrics[name].filter((m) =>
                        m.metric.startsWith(`build.${name}.entries`),
                    );

                    const metricToTest = getMetric(metric, tags);
                    const foundMetrics = entryMetrics.filter(
                        (m) =>
                            m.metric === `build.${name}.${metric}` &&
                            tags.every((t) => m.tags.includes(t)),
                    );

                    expect(foundMetrics).toHaveLength(1);
                    expect(foundMetrics[0]).toEqual({
                        ...metricToTest,
                        type: foundMetrics[0].type,
                        metric: `build.${name}.${metricToTest.metric}`,
                    });
                });
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

            type GetAssetParams = Parameters<typeof getAssetMetric>;

            describe('Asset metrics', () => {
                const assetMetricsExpectations: {
                    metric: string;
                    assetName: GetAssetParams[1];
                    entryName: GetAssetParams[2];
                    value?: GetAssetParams[3];
                }[] = [
                    { metric: 'size', assetName: 'app1.js', entryName: 'app1' },
                    { metric: 'modules.count', assetName: 'app1.js', entryName: 'app1' },
                    { metric: 'size', assetName: 'app2.js', entryName: 'app2' },
                    { metric: 'modules.count', assetName: 'app2.js', entryName: 'app2' },
                    { metric: 'size', assetName: 'app1.js.map', entryName: 'app1' },
                    {
                        metric: 'modules.count',
                        assetName: 'app1.js.map',
                        entryName: 'app1',
                        value: 1,
                    },
                    { metric: 'size', assetName: 'app2.js.map', entryName: 'app2' },
                    {
                        metric: 'modules.count',
                        assetName: 'app2.js.map',
                        entryName: 'app2',
                        value: 1,
                    },
                ];
                test.each(assetMetricsExpectations)(
                    'Should have asset.$metric for $assetName in $entryName',
                    ({ metric, assetName, entryName, value }) => {
                        const assetMetrics = metrics[name].filter((m) =>
                            m.metric.startsWith(`build.${name}.assets`),
                        );

                        const metricToTest = getAssetMetric(metric, assetName, entryName, value);
                        const foundMetrics = assetMetrics.filter(
                            (m) =>
                                m.metric === `build.${name}.${metricToTest.metric}` &&
                                [`assetName:${assetName}`, `entryName:${entryName}`].every((t) =>
                                    m.tags.includes(t),
                                ),
                        );

                        expect(foundMetrics).toHaveLength(1);
                        expect(foundMetrics[0]).toEqual({
                            ...metricToTest,
                            type: foundMetrics[0].type,
                            metric: `build.${name}.${metricToTest.metric}`,
                        });
                    },
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
                ['hard_project/workspaces/app/workspaceFile0.js', ['app1', 'app2'], 30042, 0, 2],
                ['hard_project/workspaces/app/workspaceFile1.js', ['app1', 'app2'], 4600, 1, 2],
                ['hard_project/src/srcFile1.js', ['app2'], 2237, 2, 1],
                ['hard_project/src/srcFile0.js', ['app1', 'app2'], 13248, 1, 3],
                ['escape-string-regexp/index.js', ['app1'], 226, 0, 1],
                ['color-name/index.js', ['app1'], 4617, 0, 1],
                ['color-convert/conversions.js', ['app1'], 16850, 1, 2],
                ['color-convert/route.js', ['app1'], 2227, 1, 1],
                ['color-convert/index.js', ['app1'], 1725, 2, 1],
                ['ansi-styles/index.js', ['app1'], 3574, 1, 1],
                ['supports-color/browser.js', ['app1'], 67, 0, 1],
                ['chalk/templates.js', ['app1'], 3133, 0, 1],
                // Somehow rollup and vite are not reporting the same size.
                ['chalk/index.js', ['app1'], expect.toBeWithinRange(6437, 6439), 4, 1],
                ['hard_project/main1.js', ['app1'], 462, 3, 0],
                ['hard_project/main2.js', ['app2'], 337, 2, 0],
            ];

            describe.each(modulesExpectations)(
                'Should have module metrics for %s',
                (moduleName, entryNames, size, dependencies, dependents) => {
                    test('Should have module size metrics', () => {
                        const moduleMetrics = metrics[name].filter((metric) =>
                            metric.metric.startsWith(`build.${name}.modules`),
                        );
                        const metric = getModuleMetric('size', moduleName, entryNames, size);
                        const foundMetrics = moduleMetrics.filter(
                            (m) =>
                                m.metric === `build.${name}.${metric.metric}` &&
                                m.tags.includes(`moduleName:${moduleName}`),
                        );

                        expect(foundMetrics).toHaveLength(1);
                        expect(foundMetrics[0]).toEqual({
                            ...metric,
                            type: foundMetrics[0].type,
                            metric: `build.${name}.${metric.metric}`,
                        });
                    });

                    test('Should have module dependencies metrics', () => {
                        const moduleMetrics = metrics[name].filter((metric) =>
                            metric.metric.startsWith(`build.${name}.modules`),
                        );

                        const metric = getModuleMetric(
                            'dependencies',
                            moduleName,
                            entryNames,
                            dependencies,
                        );

                        const foundMetrics = moduleMetrics.filter(
                            (m) =>
                                m.metric === `build.${name}.${metric.metric}` &&
                                m.tags.includes(`moduleName:${moduleName}`),
                        );

                        expect(foundMetrics).toHaveLength(1);
                        expect(foundMetrics[0]).toEqual({
                            ...metric,
                            type: foundMetrics[0].type,
                            metric: `build.${name}.${metric.metric}`,
                        });
                    });

                    test('Should have module dependents metrics', () => {
                        const moduleMetrics = metrics[name].filter((metric) =>
                            metric.metric.startsWith(`build.${name}.modules`),
                        );

                        const metric = getModuleMetric(
                            'dependents',
                            moduleName,
                            entryNames,
                            dependents,
                        );
                        const foundMetrics = moduleMetrics.filter(
                            (m) =>
                                m.metric === `build.${name}.${metric.metric}` &&
                                m.tags.includes(`moduleName:${moduleName}`),
                        );

                        expect(foundMetrics).toHaveLength(1);
                        expect(foundMetrics[0]).toEqual({
                            ...metric,
                            type: foundMetrics[0].type,
                            metric: `build.${name}.${metric.metric}`,
                        });
                    });
                },
            );
        });
    });

    describe('With enableStaticPrefix false', () => {
        const metrics: Record<string, Metric[]> = {};

        beforeAll(async () => {
            const pluginConfig: Options = {
                auth: { site: FAKE_SITE },
                metrics: {
                    enableStaticPrefix: false,
                    filters: [],
                },
                logLevel: 'warn',
                customPlugins: ({ context }) => debugFilesPlugins(context),
            };
            // This one is called at initialization, with the initial context.
            getMetricsToSendMocked.mockImplementation(getMetricsToSendImplem(metrics));
            await runBundlers(pluginConfig, getComplexBuildOverrides());
        });

        describe.each(BUNDLERS)('$name - $version', ({ name }) => {
            test('Should not have the build.<bundler> prefix', () => {
                const metricNames = Object.values(metrics)
                    .flatMap((metricsToSend) => metricsToSend.map((metric) => metric.metric))
                    .sort();

                expect(metricNames.length).toBeGreaterThan(0);

                metricNames.forEach((metricName) => {
                    expect(metricName).not.toMatch(new RegExp(`^build\\.${name}\\.`));
                });

                expect(Array.from(new Set(metricNames)).sort()).toEqual(genericMetrics);
            });
        });
    });
});
