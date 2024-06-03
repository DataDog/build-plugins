// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDisplayName } from '@dd/core/helpers';
import type { EsbuildStats } from '@dd/core/types';
import {
    getModules,
    getIndexed,
    getEntries,
    getAssets,
} from '@dd/telemetry-plugins/common/metrics/esbuild';
import type { Metric } from '@dd/telemetry-plugins/types';
import { exec, PROJECTS_ROOT } from '@dd/tests/plugins/telemetry/testHelpers';
import path from 'path';

describe('Telemetry ESBuild Metrics', () => {
    describe(`Esbuild`, () => {
        let statsJson: EsbuildStats;
        const ESBUILD_ROOT = path.join(PROJECTS_ROOT, `./esbuild`);
        const OUTPUT = path.join(ESBUILD_ROOT, `./esbuild-profile-debug/`);

        beforeAll(async () => {
            const output = await exec(`yarn workspace project-esbuild build`);

            // eslint-disable-next-line no-console
            console.log(`Build :`, output.stderr);

            statsJson = require(path.join(OUTPUT, './bundler.json'));
        }, 20000);

        describe('Modules', () => {
            let metrics: Metric[];

            beforeAll(() => {
                const indexed = getIndexed(statsJson, ESBUILD_ROOT);
                metrics = getModules(statsJson, indexed, ESBUILD_ROOT);
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
                const indexed = getIndexed(statsJson, ESBUILD_ROOT);
                metrics = getEntries(statsJson, indexed, ESBUILD_ROOT);
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
                const indexed = getIndexed(statsJson, ESBUILD_ROOT);
                metrics = getAssets(statsJson, indexed, ESBUILD_ROOT);
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
