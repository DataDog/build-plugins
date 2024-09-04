// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options } from '@dd/core/types';
import type { BuildOptions } from 'esbuild';
import { rmSync } from 'fs';
import type { RollupOptions } from 'rollup';
import type { Configuration as Configuration4, Stats as Stats4 } from 'webpack4';
import type { Configuration, Stats } from 'webpack';

import {
    getEsbuildOptions,
    getRollupOptions,
    getViteOptions,
    getWebpack4Options,
    getWebpackOptions,
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

    const { errors, warnings } = stats.toJson('errors-warnings');
    if (errors?.length) {
        reject(errors.join('\n'));
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

export const runWebpack = async (
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<Configuration> = {},
) => {
    const bundlerConfigs = getWebpackOptions(pluginOverrides, bundlerOverrides);
    const { webpack } = await import('webpack');
    return new Promise((resolve, reject) => {
        webpack(bundlerConfigs, (err, stats) => {
            webpackCallback(err, stats, resolve, reject);
        });
    });
};

export const runWebpack4 = async (
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<Configuration4> = {},
) => {
    const bundlerConfigs = getWebpack4Options(pluginOverrides, bundlerOverrides);
    const webpack = (await import('webpack4')).default;
    return new Promise((resolve, reject) => {
        webpack(bundlerConfigs, (err, stats) => {
            webpackCallback(err, stats, resolve, reject, 600);
        });
    });
};

export const runEsbuild = async (
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<BuildOptions> = {},
) => {
    const bundlerConfigs = getEsbuildOptions(pluginOverrides, bundlerOverrides);
    const { build } = await import('esbuild');
    return build(bundlerConfigs);
};

export const runVite = async (
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<RollupOptions> = {},
) => {
    const bundlerConfigs = getViteOptions(pluginOverrides, bundlerOverrides);
    const vite = await import('vite');
    return vite.build(bundlerConfigs);
};

export const runRollup = async (
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<RollupOptions> = {},
) => {
    const bundlerConfigs = getRollupOptions(pluginOverrides, bundlerOverrides);
    const { rollup } = await import('rollup');
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

    return result;
};

type Bundler = {
    name: string;
    run: (opts: Options, config?: any) => Promise<any>;
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
) => {
    const results: any[] = [];
    rmSync(defaultDestination, { recursive: true, force: true, maxRetries: 3 });
    // Needed to avoid SIGHUP errors with exit code 129.
    // Specifically for vite, which is the only one that crashes with this error when ran more than once.
    // TODO: Investigate why vite crashed when ran more than once.
    jest.resetModules();

    // Running vite and webpack together will crash the process with exit code 129.
    // Not sure why, but we need to isolate them.
    // TODO: Investigate why vite and webpack can't run together.
    const webpackBundlers = BUNDLERS.filter((bundler) => bundler.name.startsWith('webpack'));
    const otherBundlers = BUNDLERS.filter((bundler) => !bundler.name.startsWith('webpack'));

    const runBundlerFunction = (bundler: Bundler) => {
        let bundlerOverride = {};
        if (bundlerOverrides[bundler.name]) {
            bundlerOverride = bundlerOverrides[bundler.name];
        }
        return bundler.run(pluginOverrides, bundlerOverride);
    };

    if (webpackBundlers.length) {
        results.push(...(await Promise.all(webpackBundlers.map(runBundlerFunction))));
    }

    if (otherBundlers.length) {
        results.push(...(await Promise.all(otherBundlers.map(runBundlerFunction))));
    }

    return results;
};
