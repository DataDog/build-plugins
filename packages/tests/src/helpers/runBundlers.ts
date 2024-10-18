// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BundlerFullName, Options } from '@dd/core/types';
import { bgYellow, green, red } from '@dd/tools/helpers';
import type { BuildOptions } from 'esbuild';
import { remove } from 'fs-extra';
import path from 'path';
import type { RollupOptions } from 'rollup';
import type { Configuration as Configuration4, Stats as Stats4 } from 'webpack4';
import type { Configuration, Stats } from 'webpack5';

import {
    getEsbuildOptions,
    getRollupOptions,
    getViteOptions,
    getWebpack4Options,
    getWebpack5Options,
} from './configBundlers';
import { NO_CLEANUP, PLUGIN_VERSIONS } from './constants';
import { defaultDestination } from './mocks';
import type { Bundler, BundlerRunFunction, CleanupFn } from './types';

const webpackCallback = (
    err: Error | null,
    stats: Stats4 | Stats | undefined,
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
            proms.push(remove(outdir));
        }

        await Promise.all(proms);
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
                webpackCallback(err, stats, resolve, reject);
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
                webpackCallback(err, stats, resolve, reject, 600);
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
        version: PLUGIN_VERSIONS.webpack,
    },
    {
        name: 'webpack4',
        run: runWebpack4,
        version: PLUGIN_VERSIONS.webpack,
    },
    {
        name: 'esbuild',
        run: runEsbuild,
        version: PLUGIN_VERSIONS.esbuild,
    },
    { name: 'vite', run: runVite, version: PLUGIN_VERSIONS.vite },
    {
        name: 'rollup',
        run: runRollup,
        version: PLUGIN_VERSIONS.rollup,
    },
];

// Handle --bundlers flag.
const specificBundlers = process.argv.includes('--bundlers')
    ? process.argv[process.argv.indexOf('--bundlers') + 1].split(',')
    : process.argv
          .find((arg) => arg.startsWith('--bundlers='))
          ?.split('=')[1]
          .split(',') ?? [];

if (specificBundlers.length) {
    if (
        !(specificBundlers as BundlerFullName[]).every((bundler) =>
            allBundlers.map((b) => b.name).includes(bundler),
        )
    ) {
        throw new Error(
            `Invalid "${red(`--bundlers ${specificBundlers.join(',')}`)}".\nValid bundlers are ${allBundlers
                .map((b) => green(b.name))
                .sort()
                .join(', ')}.`,
        );
    }
    const bundlersList = specificBundlers.map((bundler) => green(bundler)).join(', ');
    console.log(`Running ${bgYellow(' ONLY ')} for ${bundlersList}.`);
}

export const BUNDLERS: Bundler[] = allBundlers.filter(
    (bundler) => specificBundlers.length === 0 || specificBundlers.includes(bundler.name),
);

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
    // Needed to avoid SIGHUP errors with exit code 129.
    // Specifically for vite, which is the only one that crashes with this error when ran more than once.
    // TODO: Investigate why vite crashed when ran more than once.
    jest.resetModules();

    // Running vite and webpack together will crash the process with exit code 129.
    // Not sure why, but we need to isolate them.
    // TODO: Investigate why vite and webpack can't run together.
    const webpackBundlers = bundlersToRun.filter((bundler) => bundler.name.startsWith('webpack'));
    const otherBundlers = bundlersToRun.filter((bundler) => !bundler.name.startsWith('webpack'));

    const runBundlerFunction = async (bundler: Bundler) => {
        let bundlerOverride = {};
        if (bundlerOverrides[bundler.name]) {
            bundlerOverride = bundlerOverrides[bundler.name];
        }

        const cleanupFn = await bundler.run(seed, pluginOverrides, bundlerOverride);
        return cleanupFn;
    };

    // Webpack builds have to be run sequentially because of
    // how we mock webpack with two different versions to be passed to the factory.
    if (webpackBundlers.length) {
        const results = [];
        for (const bundler of webpackBundlers) {
            // eslint-disable-next-line no-await-in-loop
            results.push(await runBundlerFunction(bundler));
        }
        cleanups.push(...results.map((result) => result.cleanup));
        errors.push(...results.map((result) => result.errors).flat());
    }

    if (otherBundlers.length) {
        const otherProms = otherBundlers.map(runBundlerFunction);
        const results = await Promise.all(otherProms);
        cleanups.push(...results.map((result) => result.cleanup));
        errors.push(...results.map((result) => result.errors).flat());
    }

    const cleanupEverything = async () => {
        try {
            await Promise.all(cleanups.map((cleanup) => cleanup()));

            // We don't want to clean up in debug mode.
            if (NO_CLEANUP) {
                return;
            }

            // Remove the seeded directory.
            await remove(path.resolve(defaultDestination, seed));
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
