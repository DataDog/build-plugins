// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BundlerReport, Options } from '@dd/core/types';
import { defaultDestination, defaultPluginOptions } from '@dd/tests/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/helpers/runBundlers';
import path from 'path';

describe('Bundler Report', () => {
    // Intercept contexts to verify it at the moment they're used.
    const bundlerReports: Record<string, BundlerReport> = {};
    beforeAll(async () => {
        const pluginConfig: Options = {
            ...defaultPluginOptions,
            // Use a custom plugin to intercept contexts to verify it at the moment they're used.
            customPlugins: (opts, context) => {
                const bundlerName = context.bundler.fullName;
                return [
                    {
                        name: 'custom-plugin',
                        writeBundle() {
                            const config = context.bundler.rawConfig;
                            bundlerReports[bundlerName] = JSON.parse(
                                JSON.stringify({
                                    ...context.bundler,
                                    // This is not safe to stringify.
                                    rawConfig: null,
                                }),
                            );
                            bundlerReports[bundlerName].rawConfig = config;
                        },
                    },
                ];
            },
        };

        await runBundlers(pluginConfig);
    });

    describe.each(BUNDLERS)('[$name|$version]', ({ name }) => {
        test('Should have the right output directory.', () => {
            const report = bundlerReports[name];
            const outDir = report.outDir;

            const expectedOutDir = path.join(defaultDestination, name);

            expect(outDir).toEqual(expectedOutDir);
        });

        test("Should have the bundler's options object.", () => {
            const report = bundlerReports[name];
            const rawConfig = report.rawConfig;
            expect(rawConfig).toBeDefined();
            expect(rawConfig).toEqual(expect.any(Object));
        });
    });
});
