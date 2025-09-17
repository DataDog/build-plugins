// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Metric } from '@dd/core/types';
import { defaultFilters } from '@dd/metrics-plugin/common/filters';
import {
    getMetricsToSend,
    getModuleName,
    getValueContext,
    validateOptions,
} from '@dd/metrics-plugin/common/helpers';
import type { Filter } from '@dd/metrics-plugin/types';
import { CONFIG_KEY } from '@dd/metrics-plugin';
import {
    defaultPluginOptions,
    getMockCompilation,
    getMockModule,
} from '@dd/tests/_jest/helpers/mocks';

describe('Metrics Helpers', () => {
    describe('validateOptions', () => {
        test('Should return the default options', () => {
            const options = { ...defaultPluginOptions, [CONFIG_KEY]: {} };
            expect(validateOptions(options, 'webpack')).toEqual({
                enable: true,
                enableDefaultPrefix: true,
                enableTracing: false,
                filters: defaultFilters,
                prefix: 'build.webpack',
                tags: [],
                timestamp: expect.any(Number),
            });
        });

        test('Should return the options with the provided values', () => {
            const fakeFilter = jest.fn();
            const options = {
                ...defaultPluginOptions,
                [CONFIG_KEY]: {
                    enable: false,
                    enableTracing: true,
                    filters: [fakeFilter],
                    prefix: 'prefix',
                    tags: ['tag1'],
                },
            };
            expect(validateOptions(options, 'webpack')).toEqual({
                enable: false,
                enableDefaultPrefix: true,
                enableTracing: true,
                filters: [fakeFilter],
                prefix: 'build.webpack.prefix',
                tags: ['tag1'],
                timestamp: expect.any(Number),
            });
        });
    });

    describe('getModuleName', () => {
        test('Should use the moduleGraphAPI with webpack', () => {
            const unnamedModule = getMockModule({ name: '' });
            const namedModule = getMockModule({ userRequest: 'moduleName' });
            expect(
                getModuleName(
                    unnamedModule,
                    getMockCompilation({
                        moduleGraph: {
                            getIssuer: () => namedModule,
                            getModule: () => namedModule,
                            issuer: namedModule,
                        },
                    }),
                ),
            ).toBe('moduleName');
        });
    });

    describe('getValueContext', () => {
        test('Should getContext with and without constructor', () => {
            const BasicClass: any = function BasicClass() {};
            const instance1 = new BasicClass();
            const instance2 = new BasicClass();
            instance2.constructor = null;

            expect(() => {
                getValueContext([instance1, instance2]);
            }).not.toThrow();

            const context = getValueContext([instance1, instance2]);
            expect(context).toEqual([
                {
                    type: 'BasicClass',
                },
                {
                    type: 'object',
                },
            ]);
        });
    });

    describe('getMetricsToSend', () => {
        const timestamp = 1234567890;

        test('Should handle empty metrics set', () => {
            const metrics = new Set<Metric>();

            const result = getMetricsToSend(metrics, timestamp, [], [], 'prefix');

            const resultArray = Array.from(result);
            expect(resultArray).toHaveLength(1); // Only metrics.count

            const countMetric = resultArray.find((m) => m.metric === 'prefix.metrics.count');
            expect(countMetric?.points).toEqual([[timestamp, 1]]); // Only counting itself
        });

        test('Should add the metrics.count, wrap metrics with prefix and tags and apply filters', () => {
            const metrics = new Set<Metric>([
                {
                    metric: 'modified.metric',
                    type: 'size',
                    points: [[timestamp, 100]],
                    tags: ['env:prod'],
                },
                {
                    metric: 'allowed.metric',
                    type: 'count',
                    points: [[timestamp, 5]],
                    tags: [],
                },
                {
                    metric: 'filtered.metric',
                    type: 'count',
                    points: [[timestamp, 10]],
                    tags: [],
                },
            ]);

            const filters: Filter[] = [
                // Add a tag to all the metrics.
                (metric) => ({
                    ...metric,
                    tags: [...metric.tags, 'filter1:applied'],
                }),
                // Filter out a specific metric.
                (metric) => {
                    if (metric.metric === 'filtered.metric') {
                        return null;
                    }
                    return metric;
                },
                // Modify a specific metric.
                (metric) => {
                    if (metric.metric === 'modified.metric') {
                        return {
                            ...metric,
                            metric: `x.${metric.metric}`,
                        };
                    }
                    return metric;
                },
            ];

            const result = Array.from(getMetricsToSend(metrics, timestamp, filters, [], 'prefix'));

            const allowedMetric = result.find((m) => m.metric.endsWith('allowed.metric'));
            const filteredMetric = result.find((m) => m.metric.endsWith('filtered.metric'));
            const modifiedMetric = result.find((m) => m.metric.endsWith('modified.metric'));
            const countMetric = result.find((m) => m.metric.endsWith('metrics.count'));

            expect(result).toHaveLength(4);
            expect(allowedMetric).toEqual({
                metric: 'prefix.allowed.metric',
                type: 'count',
                points: [[timestamp, 5]],
                tags: ['filter1:applied'],
                toSend: true,
            });
            expect(filteredMetric).toEqual({
                metric: 'prefix.filtered.metric',
                type: 'count',
                points: [[timestamp, 10]],
                tags: ['filter1:applied'],
                toSend: false,
            });
            expect(modifiedMetric).toEqual({
                metric: 'prefix.x.modified.metric',
                type: 'size',
                points: [[timestamp, 100]],
                tags: ['env:prod', 'filter1:applied'],
                toSend: true,
            });
            expect(countMetric).toEqual({
                metric: 'prefix.metrics.count',
                type: 'count',
                points: [[timestamp, 3]],
                tags: [],
                toSend: true,
            });
        });
    });
});
