// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDisplayName } from '@dd/telemetry-plugins/common/helpers';
import {
    getModules,
    getIndexed,
    getEntries,
    getAssets,
} from '@dd/telemetry-plugins/common/metrics/esbuild';
import type { Metric, EsbuildStats } from '@dd/telemetry-plugins/types';
import { runEsbuild } from '@dd/tests/helpers/runBundlers';
import { PROJECT_ROOT, prefixPath } from '@dd/tests/plugins/telemetry/testHelpers';
import fs from 'fs';
import path from 'path';

describe('Telemetry ESBuild Metrics', () => {
    describe(`Esbuild`, () => {
        let statsJson: EsbuildStats;
        const OUTPUT = path.resolve(PROJECT_ROOT, `./esbuild-output/`);

        afterAll(async () => {
            // Clean
            fs.rmdirSync(OUTPUT, { recursive: true });
        });

        beforeAll(async () => {
            await runEsbuild(
                {
                    auth: {
                        apiKey: '',
                    },
                    telemetry: {
                        output: OUTPUT,
                    },
                },
                {
                    sourcemap: false,
                    entryPoints: {
                        yolo: prefixPath('./src/file0001.js'),
                        cheesecake: prefixPath('./src/file0000.js'),
                    },
                    outdir: prefixPath('./esbuild-output/dist'),
                },
            );

            statsJson = require(path.resolve(OUTPUT, './bundler.json'));
        }, 20000);

        describe('Modules', () => {
            let metrics: Metric[];

            beforeAll(() => {
                const indexed = getIndexed(statsJson, PROJECT_ROOT);
                metrics = getModules(statsJson, indexed, PROJECT_ROOT);
            });

            test('It should give module metrics.', () => {
                expect(metrics.length).not.toBe(0);
            });

            test(`It should add tags about the entry and the chunk.`, () => {
                for (const metric of metrics) {
                    expect(metric.tags).toContain('entryName:yolo');
                    expect(metric.tags).toContain('entryName:cheesecake');
                }
            });

            test('It should have 1 metric per module.', () => {
                const modules = [
                    prefixPath('./src/file0000.js'),
                    prefixPath('./src/file0001.js'),
                    prefixPath('./workspaces/app/file0000.js'),
                    prefixPath('./workspaces/app/file0001.js'),
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
                const indexed = getIndexed(statsJson, PROJECT_ROOT);
                metrics = getEntries(statsJson, indexed, PROJECT_ROOT);
            });

            test('It should give entries metrics.', () => {
                expect(metrics.length).not.toBe(0);
            });

            test('It should give 3 metrics per entry.', () => {
                const entries = ['yolo', 'cheesecake'];

                for (const entry of entries) {
                    const entriesMetrics = metrics.filter((m) =>
                        m.tags.includes(`entryName:${entry}`),
                    );
                    expect(entriesMetrics.length).toBe(3);
                }
            });
        });

        describe('Assets', () => {
            let metrics: Metric[];

            beforeAll(() => {
                const indexed = getIndexed(statsJson, PROJECT_ROOT);
                metrics = getAssets(statsJson, indexed, PROJECT_ROOT);
            });

            test('It should give assets metrics.', () => {
                expect(metrics.length).not.toBe(0);
            });

            test('It should give 1 metric per asset.', () => {
                const assets = ['yolo\\.js', 'cheesecake\\.js'];
                for (const asset of assets) {
                    const rx = new RegExp(`^assetName:.*${asset}$`);
                    const assetsMetrics = metrics.filter((m) =>
                        m.tags.some((tag: string) => rx.test(tag)),
                    );
                    expect(assetsMetrics.length).toBe(1);
                }
            });

            test(`It should add tags about the entry.`, () => {
                for (const metric of metrics) {
                    expect(metric.tags).toContain('entryName:yolo');
                    expect(metric.tags).toContain('entryName:cheesecake');
                }
            });
        });
    });
});
