// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options } from '@dd/core/types';
import type { BuildOptions } from 'esbuild';
import { remove } from 'fs-extra';
import path from 'path';
import type { RollupOptions } from 'rollup';
import type { Configuration as Configuration4, Stats as Stats4 } from 'webpack4';
import type { Configuration, Stats } from 'webpack';

import {
    getEsbuildOptions,
    getRollupOptions,
    getViteOptions,
    getWebpack4Options,
    getWebpack5Options,
} from './configBundlers';
import { defaultDestination } from './mocks';

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

export type CleanupFn = () => Promise<void>;
type BundlerRunFunction = (
    seed: string,
    pluginOverrides: Options,
    bundlerOverrides: any,
) => Promise<CleanupFn>;

const getCleanupFunction =
    (bundlerName: string, outdirs: (string | undefined)[]): CleanupFn =>
    async () => {
        const proms = [];

        if (!outdirs.filter(Boolean).length) {
            console.error(`Missing output path for ${bundlerName} cleanup.`);
        }

        for (const outdir of outdirs.filter(Boolean) as string[]) {
            proms.push(remove(outdir));
        }

        await Promise.all(proms);
    };

export const runWebpack: BundlerRunFunction = async (
    seed: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<Configuration> = {},
) => {
    const bundlerConfigs = getWebpack5Options(seed, pluginOverrides, bundlerOverrides);
    const { webpack } = await import('webpack');

    try {
        await new Promise((resolve, reject) => {
            webpack(bundlerConfigs, (err, stats) => {
                webpackCallback(err, stats, resolve, reject);
            });
        });
    } catch (e: any) {
        console.error(`Build failed for Webpack 5`, e);
    }

    return getCleanupFunction('Webpack 5', [bundlerConfigs.output?.path]);
};

export const runWebpack4: BundlerRunFunction = async (
    seed: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<Configuration4> = {},
) => {
    const bundlerConfigs = getWebpack4Options(seed, pluginOverrides, bundlerOverrides);
    const webpack = (await import('webpack4')).default;
    try {
        await new Promise((resolve, reject) => {
            webpack(bundlerConfigs, (err, stats) => {
                webpackCallback(err, stats, resolve, reject, 600);
            });
        });
    } catch (e: any) {
        console.error(`Build failed for Webpack 5`, e);
    }

    return getCleanupFunction('Webpack 4', [bundlerConfigs.output?.path]);
};

export const runEsbuild: BundlerRunFunction = async (
    seed: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<BuildOptions> = {},
) => {
    const bundlerConfigs = getEsbuildOptions(seed, pluginOverrides, bundlerOverrides);
    const { build } = await import('esbuild');

    try {
        await build(bundlerConfigs);
    } catch (e: any) {
        console.error(`Build failed for ESBuild`, e);
    }

    return getCleanupFunction('ESBuild', [bundlerConfigs.outdir]);
};

export const runVite: BundlerRunFunction = async (
    seed: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<RollupOptions> = {},
) => {
    const bundlerConfigs = getViteOptions(seed, pluginOverrides, bundlerOverrides);
    const vite = await import('vite');
    try {
        await vite.build(bundlerConfigs);
    } catch (e) {
        console.error(`Build failed for Vite`, e);
    }

    const outdirs: (string | undefined)[] = [];
    if (Array.isArray(bundlerConfigs.build?.rollupOptions?.output)) {
        outdirs.push(...bundlerConfigs.build.rollupOptions.output.map((o) => o.dir));
    } else if (bundlerConfigs.build?.rollupOptions?.output?.dir) {
        outdirs.push(bundlerConfigs.build.rollupOptions.output.dir);
    }

    return getCleanupFunction('Vite', outdirs);
};

export const runRollup: BundlerRunFunction = async (
    seed: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<RollupOptions> = {},
) => {
    const bundlerConfigs = getRollupOptions(seed, pluginOverrides, bundlerOverrides);
    const { rollup } = await import('rollup');

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
    } catch (e) {
        console.error(`Build failed for Rollup`, e);
    }

    const outdirs: (string | undefined)[] = [];
    if (Array.isArray(bundlerConfigs.output)) {
        outdirs.push(...bundlerConfigs.output.map((o) => o.dir));
    } else if (bundlerConfigs.output?.dir) {
        outdirs.push(bundlerConfigs.output.dir);
    }
    return getCleanupFunction('Rollup', outdirs);
};

export type Bundler = {
    name: string;
    run: BundlerRunFunction;
    version: string;
};

export const BUNDLERS: Bundler[] = [
    {
        name: 'webpack5',
        run: runWebpack,
        version: require('@datadog/webpack-plugin').version,
    },
    {
        name: 'webpack4',
        run: runWebpack4,
        version: require('@datadog/webpack-plugin').version,
    },
    {
        name: 'esbuild',
        run: runEsbuild,
        version: require('@datadog/esbuild-plugin').version,
    },
    { name: 'vite', run: runVite, version: require('@datadog/vite-plugin').version },
    {
        name: 'rollup',
        run: runRollup,
        version: require('@datadog/rollup-plugin').version,
    },
].filter((bundler) => {
    // Filter out only the needed bundlers if --bundlers is provided.

    // With --bundlers webpack5,esbuild
    const indexOfFlag = process.argv.indexOf('--bundlers');
    if (indexOfFlag >= 0) {
        return process.argv[indexOfFlag + 1].includes(bundler.name);
    }

    // With --bundlers=webpack4,rollup
    const flag = process.argv.find((arg) => arg.startsWith('--bundlers'));
    if (flag) {
        const value = flag.split('=')[1];
        return value.includes(bundler.name);
    }

    return true;
});

export const runBundlers = async (
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides: Record<string, any> = {},
    bundlers?: string[],
): Promise<CleanupFn> => {
    const cleanups: CleanupFn[] = [];

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

    if (webpackBundlers.length) {
        const webpackProms = webpackBundlers.map(runBundlerFunction);
        const cleanupFns = await Promise.all(webpackProms);
        cleanups.push(...cleanupFns);
    }

    if (otherBundlers.length) {
        const otherProms = otherBundlers.map(runBundlerFunction);
        const cleanupFns = await Promise.all(otherProms);
        cleanups.push(...cleanupFns);
    }

    // Return a cleanUp function.
    return async () => {
        await Promise.all(cleanups.map((cleanup) => cleanup()));
        // Remove the seeded directory.
        await remove(path.resolve(defaultDestination, seed));
    };
};
