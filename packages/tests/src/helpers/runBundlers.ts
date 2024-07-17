// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options } from '@dd/core/types';
import type { BuildOptions } from 'esbuild';
import { rmSync } from 'fs';
import type { RollupOptions } from 'rollup';
import type { UserConfig } from 'vite';
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
    bundlerOverrides: Partial<UserConfig> = {},
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

export const BUNDLERS: {
    name: string;
    run: (opts: Options, config?: any) => Promise<any>;
}[] = [
    { name: 'webpack', run: runWebpack },
    { name: 'webpack4', run: runWebpack4 },
    { name: 'esbuild', run: runEsbuild },
    { name: 'vite', run: runVite },
    { name: 'rollup', run: runRollup },
];

export const runBundlers = async (pluginOverrides: Partial<Options> = {}) => {
    const results: any[] = [];
    rmSync(defaultDestination, { recursive: true, force: true, maxRetries: 3 });

    // Running vite and webpack together will crash the process with exit code 129.
    // Not sure why, but we need to isolate them.
    // TODO: Investigate why vite and webpack can't run together.
    const webpackBundlers = BUNDLERS.filter((bundler) => bundler.name.startsWith('webpack'));
    const otherBundlers = BUNDLERS.filter((bundler) => !bundler.name.startsWith('webpack'));
    if (webpackBundlers.length) {
        results.push(
            ...(await Promise.all(webpackBundlers.map((bundler) => bundler.run(pluginOverrides)))),
        );
    }
    if (otherBundlers.length) {
        results.push(
            ...(await Promise.all(otherBundlers.map((bundler) => bundler.run(pluginOverrides)))),
        );
    }

    return results;
};
