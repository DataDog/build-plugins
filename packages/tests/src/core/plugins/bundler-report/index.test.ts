// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, Options } from '@dd/core/types';
import { defaultDestination, defaultPluginOptions } from '@dd/tests/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/helpers/runBundlers';
import path from 'path';

describe('Bundler Report', () => {
    // Intercept contexts to verify it at the moment they're used.
    const lateContexts: Record<string, GlobalContext> = {};
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
                            lateContexts[bundlerName] = JSON.parse(JSON.stringify(context));
                        },
                    },
                ];
            },
        };

        await runBundlers(pluginConfig);
    });

    describe.each(BUNDLERS)('[$name|$version]', ({ name }) => {
        test('Should have the right output directory.', () => {
            const context = lateContexts[name];
            const outDir = context.bundler.outDir;

            const expectedOutDir = path.join(defaultDestination, name);

            expect(outDir).toEqual(expectedOutDir);
        });

        test("Should have the bundler's options object.", () => {
            const context = lateContexts[name];
            const rawConfig = context.bundler.rawConfig;
            expect(rawConfig).toBeDefined();
            expect(rawConfig).toEqual(expect.any(Object));
        });
    });
});
