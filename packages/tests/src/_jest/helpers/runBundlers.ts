// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers';
import type { Options } from '@dd/core/types';
import { executeSync, green } from '@dd/tools/helpers';
import type { RspackOptions, Stats as RspackStats } from '@rspack/core';
import type { BuildOptions } from 'esbuild';
import path from 'path';
import type { RollupOptions } from 'rollup';
import type { Configuration as Configuration4, Stats as Stats4 } from 'webpack4';
import type { Configuration, Stats } from 'webpack5';

import {
    getEsbuildOptions,
    getRollupOptions,
    getRspackOptions,
    getViteOptions,
    getWebpack4Options,
    getWebpack5Options,
} from './configBundlers';

// Get the environment variables.
const { NO_CLEANUP, NEED_BUILD, REQUESTED_BUNDLERS } = process.env;

const xpackCallback = (
    err: Error | null,
    stats: Stats4 | Stats | RspackStats | undefined,
    resolve: (value: unknown) => void,
    reject: (reason?: any) => void,
    delay: number = 0,
) => {
    if (err) {
        reject(err);
        return;
    }

    if (!stats) {
        reject('No stats returned from webpack.');
        return;
    }

    const { errors, warnings } = stats.compilation;
    if (errors?.length) {
        reject(errors[0]);
        return;
    }

    if (warnings?.length) {
        console.warn(warnings.join('\n'));
    }

    // Delay the resolve to give time to the bundler to finish writing the files.
    // Webpack4 in particular is impacted by this and otherwise triggers a
    // "Jest did not exit one second after the test run has completed." warning.
    // TODO: Investigate this need for a delay after webpack 4's build.
    setTimeout(() => {
        resolve(stats);
    }, delay);
};

const getCleanupFunction =
    (bundlerName: string, outdirs: (string | undefined)[]): CleanupFn =>
    async () => {
        // We don't want to clean up in debug mode.
        if (NO_CLEANUP) {
            return;
        }

        const proms = [];

        if (!outdirs.filter(Boolean).length) {
            console.error(`Missing output path for ${bundlerName} cleanup.`);
        }

        for (const outdir of outdirs.filter(Boolean) as string[]) {
            proms.push(rm(outdir));
        }

        await Promise.all(proms);
    };

export const runRspack: BundlerRunFunction = async (
    seed: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<RspackOptions> = {},
) => {
    const bundlerConfigs = getRspackOptions(seed, pluginOverrides, bundlerOverrides);
    const { rspack } = await import('@rspack/core');
    const errors = [];

    try {
        await new Promise((resolve, reject) => {
            rspack(bundlerConfigs, (err, stats) => {
                xpackCallback(err, stats, resolve, reject);
            });
        });
    } catch (e: any) {
        console.error(`Build failed for Rspack`, e);
        errors.push(`[RSPACK] : ${e.message}`);
    }

    return { cleanup: getCleanupFunction('Rspack', [bundlerConfigs.output?.path]), errors };
};

export const runWebpack5: BundlerRunFunction = async (
    seed: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<Configuration> = {},
) => {
    const bundlerConfigs = getWebpack5Options(seed, pluginOverrides, bundlerOverrides);
    const { webpack } = await import('webpack5');
    const errors = [];

    try {
        await new Promise((resolve, reject) => {
            webpack(bundlerConfigs, (err, stats) => {
                xpackCallback(err, stats, resolve, reject);
            });
        });
    } catch (e: any) {
        console.error(`Build failed for Webpack 5`, e);
        errors.push(`[WEBPACK5] : ${e.message}`);
    }

    return { cleanup: getCleanupFunction('Webpack 5', [bundlerConfigs.output?.path]), errors };
};

export const runWebpack4: BundlerRunFunction = async (
    seed: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<Configuration4> = {},
) => {
    const bundlerConfigs = getWebpack4Options(seed, pluginOverrides, bundlerOverrides);
    const webpack = (await import('webpack4')).default;
    const errors = [];

    try {
        await new Promise((resolve, reject) => {
            webpack(bundlerConfigs, (err, stats) => {
                xpackCallback(err, stats, resolve, reject, 600);
            });
        });
    } catch (e: any) {
        console.error(`Build failed for Webpack 4`, e);
        errors.push(`[WEBPACK4] : ${e.message}`);
    }

    return { cleanup: getCleanupFunction('Webpack 4', [bundlerConfigs.output?.path]), errors };
};

export const runEsbuild: BundlerRunFunction = async (
    seed: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<BuildOptions> = {},
) => {
    const bundlerConfigs = getEsbuildOptions(seed, pluginOverrides, bundlerOverrides);
    const { build } = await import('esbuild');
    const errors = [];

    try {
        await build(bundlerConfigs);
    } catch (e: any) {
        console.error(`Build failed for ESBuild`, e);
        errors.push(`[ESBUILD] : ${e.message}`);
    }

    return { cleanup: getCleanupFunction('ESBuild', [bundlerConfigs.outdir]), errors };
};

export const runVite: BundlerRunFunction = async (
    seed: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<RollupOptions> = {},
) => {
    const bundlerConfigs = getViteOptions(seed, pluginOverrides, bundlerOverrides);
    const vite = await import('vite');
    const errors = [];
    try {
        await vite.build(bundlerConfigs);
    } catch (e: any) {
        console.error(`Build failed for Vite`, e);
        errors.push(`[VITE] : ${e.message}`);
    }

    const outdirs: (string | undefined)[] = [];
    if (Array.isArray(bundlerConfigs.build?.rollupOptions?.output)) {
        outdirs.push(...bundlerConfigs.build.rollupOptions.output.map((o) => o.dir));
    } else if (bundlerConfigs.build?.rollupOptions?.output?.dir) {
        outdirs.push(bundlerConfigs.build.rollupOptions.output.dir);
    }

    return { cleanup: getCleanupFunction('Vite', outdirs), errors };
};

export const runRollup: BundlerRunFunction = async (
    seed: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<RollupOptions> = {},
) => {
    const bundlerConfigs = getRollupOptions(seed, pluginOverrides, bundlerOverrides);
    const { rollup } = await import('rollup');
    const errors = [];

    try {
        const result = await rollup(bundlerConfigs);

        // Write out the results.
        if (bundlerConfigs.output) {
            const outputProms = [];
            const outputOptions = Array.isArray(bundlerConfigs.output)
                ? bundlerConfigs.output
                : [bundlerConfigs.output];
            for (const outputOption of outputOptions) {
                outputProms.push(result.write(outputOption));
            }

            await Promise.all(outputProms);
        }
    } catch (e: any) {
        console.error(`Build failed for Rollup`, e);
        errors.push(`[ROLLUP] : ${e.message}`);
    }

    const outdirs: (string | undefined)[] = [];
    if (Array.isArray(bundlerConfigs.output)) {
        outdirs.push(...bundlerConfigs.output.map((o) => o.dir));
    } else if (bundlerConfigs.output?.dir) {
        outdirs.push(bundlerConfigs.output.dir);
    }

    return { cleanup: getCleanupFunction('Rollup', outdirs), errors };
};

const allBundlers: Bundler[] = [
    {
        name: 'webpack5',
        run: runWebpack5,
        config: getWebpack5Options,
        version: PLUGIN_VERSIONS.webpack,
    },
    {
        name: 'webpack4',
        run: runWebpack4,
        config: getWebpack4Options,
        version: PLUGIN_VERSIONS.webpack,
    },
    {
        name: 'rspack',
        run: runRspack,
        config: getRspackOptions,
        version: PLUGIN_VERSIONS.rspack,
    },
    {
        name: 'esbuild',
        run: runEsbuild,
        config: getEsbuildOptions,
        version: PLUGIN_VERSIONS.esbuild,
    },
    {
        name: 'vite',
        run: runVite,
        config: getViteOptions,
        version: PLUGIN_VERSIONS.vite,
    },
    {
        name: 'rollup',
        run: runRollup,
        config: getRollupOptions,
        version: PLUGIN_VERSIONS.rollup,
    },
];

const requestedBundlers = REQUESTED_BUNDLERS ? REQUESTED_BUNDLERS.split(',') : [];
export const BUNDLERS: Bundler[] = allBundlers.filter(
    (bundler) => requestedBundlers.length === 0 || requestedBundlers.includes(bundler.name),
);

// Build only if needed.
if (NEED_BUILD) {
    const bundlersToBuild = new Set(
        BUNDLERS.map((bundler) => `@datadog/${bundler.name.replace(/\d/g, '')}-plugin`),
    );

    for (const bundler of bundlersToBuild) {
        console.log(`Building ${green(bundler)}...`);
        // Can't do parallel builds because no await at root.
        executeSync('yarn', ['workspace', bundler, 'run', 'build']);
    }
}

export const runBundlers = async (
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: Record<string, any> = {},
    bundlers?: string[],
): Promise<CleanupFn> => {
    const cleanups: CleanupFn[] = [];
    const errors: string[] = [];

    // Generate a seed to avoid collision of builds.
    const seed: string = `${Date.now()}-${jest.getSeed()}`;

    const bundlersToRun = BUNDLERS.filter(
        (bundler) => !bundlers || bundlers.includes(bundler.name),
    );

    const runBundlerFunction = async (bundler: Bundler) => {
        let bundlerOverride = {};
        if (bundlerOverrides[bundler.name]) {
            bundlerOverride = bundlerOverrides[bundler.name];
        }

        let result: Awaited<ReturnType<BundlerRunFunction>>;
        // Isolate each runs to avoid conflicts between tests.
        await jest.isolateModulesAsync(async () => {
            result = await bundler.run(seed, pluginOverrides, bundlerOverride);
        });
        return result!;
    };

    // Run the bundlers sequentially to ease the resources usage.
    const results = [];
    for (const bundler of bundlersToRun) {
        // eslint-disable-next-line no-await-in-loop
        results.push(await runBundlerFunction(bundler));
    }
    cleanups.push(...results.map((result) => result.cleanup));
    errors.push(...results.map((result) => result.errors).flat());

    // Add a cleanup for the root seeded directory.
    cleanups.push(getCleanupFunction('Root', [path.resolve(defaultDestination, seed)]));

    const cleanupEverything = async () => {
        try {
            await Promise.all(cleanups.map((cleanup) => cleanup()));
        } catch (e) {
            console.error('Error during cleanup', e);
        }
    };

    if (errors.length) {
        // We'll throw, so clean everything first.
        await cleanupEverything();
        throw new Error(errors.join('\n'));
    }

    // Return a cleanUp function.
    return cleanupEverything;
};
