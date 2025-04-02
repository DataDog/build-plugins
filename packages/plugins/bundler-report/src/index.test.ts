// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BundlerReport, Options } from '@dd/core/types';
import { defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';

describe('Bundler Report', () => {
    // Intercept contexts to verify it at the moment they're used.
    const bundlerReports: Record<string, BundlerReport> = {};
    const cwds: Record<string, string> = {};
    let workingDir: string;
    beforeAll(async () => {
        const pluginConfig: Options = {
            ...defaultPluginOptions,
            // Use a custom plugin to intercept contexts to verify it at the moment they're used.
            customPlugins: ({ context }) => {
                const bundlerName = context.bundler.fullName;
                return [
                    {
                        name: 'custom-plugin',
                        bundlerReport(report) {
                            const config = report.rawConfig;
                            bundlerReports[bundlerName] = JSON.parse(
                                JSON.stringify({
                                    ...report,
                                    // This is not safe to stringify.
                                    rawConfig: null,
                                }),
                            );
                            bundlerReports[bundlerName].rawConfig = config;
                        },
                        cwd(cwd) {
                            cwds[bundlerName] = cwd;
                        },
                    },
                ];
            },
        };

        const result = await runBundlers(pluginConfig);
        workingDir = result.workingDir;
    });

    describe.each(BUNDLERS)('[$name|$version]', ({ name }) => {
        test('Should have the right output directory.', () => {
            const report = bundlerReports[name];
            const outDir = report.outDir;

            const expectedOutDir = new RegExp(`^${workingDir}/[^/]+/${name}$`);

            expect(outDir).toMatch(expectedOutDir);
        });

        test("Should have the bundler's options object.", () => {
            const report = bundlerReports[name];
            const rawConfig = report.rawConfig;
            expect(rawConfig).toBeDefined();
            expect(rawConfig).toEqual(expect.any(Object));
        });

        test('Should have the right cwd.', () => {
            expect(cwds[name]).toBe(workingDir);
        });
    });
});
