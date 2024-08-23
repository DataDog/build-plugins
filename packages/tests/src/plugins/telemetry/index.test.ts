// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options } from '@dd/core/types';
import { defaultDestination } from '@dd/tests/helpers/mocks';
import { runBundlers } from '@dd/tests/helpers/runBundlers';
import path from 'path';

describe('Telemetry Universal Plugin', () => {
    test('It should run', async () => {
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

        await runBundlers(pluginConfig, bundlerOverrides);
    });
});
