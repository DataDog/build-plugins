import { rmSync } from 'fs';
import path from 'path';
import type { RollupOptions } from 'rollup';

import { defaultDestination } from '../../helpers/mocks';
import { runEsbuild, runRollup, runVite, runWebpack, runWebpack4 } from '../../helpers/runBundlers';

describe('Telemetry Universal Plugin', () => {
    test('It should run', async () => {
        rmSync(defaultDestination, { recursive: true, force: true, maxRetries: 3 });

        const newEntries = {
            app1: '@dd/tests/fixtures/project/main1.js',
            app2: '@dd/tests/fixtures/project/main2.js',
        };
        const newEntriesWebpack4 = {
            app1: `./${path.relative(process.cwd(), require.resolve('@dd/tests/fixtures/project/main1.js'))}`,
            app2: `./${path.relative(process.cwd(), require.resolve('@dd/tests/fixtures/project/main2.js'))}`,
        };

        const rollupOverrides: RollupOptions = {
            input: newEntries,
        };

        const pluginOptions = {
            telemetry: {},
        };

        await Promise.all([
            runRollup(pluginOptions, rollupOverrides),
            runVite(pluginOptions, rollupOverrides),
            runEsbuild(pluginOptions, {
                entryPoints: newEntries,
                outdir: path.join(defaultDestination, 'esbuild'),
            }),
        ]);
        await Promise.all([
            runWebpack(pluginOptions, { entry: newEntries }),
            runWebpack4(pluginOptions, { entry: newEntriesWebpack4 }),
        ]);
    });
});
