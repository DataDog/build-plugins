// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDisplayName } from '@dd/core/helpers';
import type { StatsJson } from '@dd/core/types';
import {
    getModules,
    getIndexed,
    getEntries,
    getChunks,
    getAssets,
} from '@dd/telemetry-plugins/common/metrics/webpack';
import type { Metric } from '@dd/telemetry-plugins/types';
import path from 'path';

import { exec, PROJECTS_ROOT } from '../../../testHelpers';

describe('Metrics', () => {
    beforeAll(async () => {
        await exec(`yarn build`);
    }, 20000);

    for (const version of [4, 5]) {
        describe(`Webpack ${version}`, () => {
            let statsJson: StatsJson;
            const WEBPACK_ROOT = path.join(PROJECTS_ROOT, `./webpack${version}`);
            const OUTPUT = path.join(WEBPACK_ROOT, `./webpack-profile-debug/`);

            beforeAll(async () => {
                const output = await exec(`yarn workspace project-webpack${version} build`);

                // eslint-disable-next-line no-console
                console.log(`Build ${version} :`, output.stderr);

                statsJson = require(path.join(OUTPUT, './bundler.json'));
            }, 20000);

            describe('Modules', () => {
                let metrics: Metric[];

                beforeAll(() => {
                    const indexed = getIndexed(statsJson, WEBPACK_ROOT);
                    metrics = getModules(statsJson, indexed, WEBPACK_ROOT);
                });

                test('It should give module metrics.', () => {
                    expect(metrics.length).not.toBe(0);
                });

                test(`It should filter out webpack's modules.`, () => {
                    expect(
                        metrics.find((m) => {
                            return m.tags.find((t) => /^moduleName:webpack\/runtime/.test(t));
                        }),
                    ).toBeUndefined();
                });

                test(`It should add tags about the entry and the chunk.`, () => {
                    for (const metric of metrics) {
                        expect(metric.tags).toContain('entryName:yolo');
                        expect(metric.tags).toContain('entryName:cheesecake');
                        expect(metric.tags).toContain('chunkName:yolo');
                        expect(metric.tags).toContain('chunkName:cheesecake');
                    }
                });

                test('It should have 1 metric per module.', () => {
                    const modules = [
                        './src/file0000.js',
                        './src/file0001.js',
                        './workspaces/app/file0000.js',
                        './workspaces/app/file0001.js',
                    ];

                    for (const module of modules) {
                        const modulesMetrics = metrics.filter((m) =>
                            m.tags.includes(`moduleName:${getDisplayName(module)}`),
                        );
                        expect(modulesMetrics.length).toBe(1);
                    }
                });
            });

            describe('Entries', () => {
                let metrics: Metric[];

                beforeAll(() => {
                    const indexed = getIndexed(statsJson, WEBPACK_ROOT);
                    metrics = getEntries(statsJson, indexed);
                });

                test('It should give entries metrics.', () => {
                    expect(metrics.length).not.toBe(0);
                });

                test('It should give 4 metrics per entry.', () => {
                    const entries = ['yolo', 'cheesecake'];

                    for (const entry of entries) {
                        const entriesMetrics = metrics.filter((m) =>
                            m.tags.includes(`entryName:${entry}`),
                        );
                        expect(entriesMetrics.length).toBe(4);
                    }
                });
            });

            describe('Chunks', () => {
                let metrics: Metric[];

                beforeAll(() => {
                    const indexed = getIndexed(statsJson, WEBPACK_ROOT);
                    metrics = getChunks(statsJson, indexed);
                });

                test('It should give chunks metrics.', () => {
                    expect(metrics.length).not.toBe(0);
                });

                test('It should give 2 metrics per chunk.', () => {
                    const chunks = ['yolo', 'cheesecake'];

                    for (const chunk of chunks) {
                        const chunksMetrics = metrics.filter((m) =>
                            m.tags.includes(`chunkName:${chunk}`),
                        );
                        expect(chunksMetrics.length).toBe(2);
                    }
                });

                test(`It should add tags about the entry.`, () => {
                    for (const metric of metrics) {
                        expect(metric.tags.join(',')).toMatch(/entryName:(yolo|cheesecake)/);
                    }
                });
            });

            describe('Assets', () => {
                let metrics: Metric[];

                beforeAll(() => {
                    const indexed = getIndexed(statsJson, WEBPACK_ROOT);
                    metrics = getAssets(statsJson, indexed);
                });

                test('It should give assets metrics.', () => {
                    expect(metrics.length).not.toBe(0);
                });

                test('It should give 1 metric per asset.', () => {
                    const assets = ['yolo.js', 'cheesecake.js'];

                    for (const asset of assets) {
                        const assetsMetrics = metrics.filter((m) =>
                            m.tags.includes(`assetName:${asset}`),
                        );
                        expect(assetsMetrics.length).toBe(1);
                    }
                });

                test(`It should add tags about the entry and the chunk.`, () => {
                    for (const metric of metrics) {
                        expect(metric.tags).toContain('entryName:yolo');
                        expect(metric.tags).toContain('entryName:cheesecake');
                        expect(metric.tags).toContain('chunkName:yolo');
                        expect(metric.tags).toContain('chunkName:cheesecake');
                    }
                });
            });
        });
    }
});
