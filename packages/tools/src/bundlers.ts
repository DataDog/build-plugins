// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BundlerName } from '@dd/core/types';
import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import type {
    RspackOptions,
    Stats as RspackStats,
    StatsCompilation as RspackStatsCompilation,
} from '@rspack/core';
import type { BuildOptions, BuildResult } from 'esbuild';
import path from 'path';
import type { RollupOptions, RollupOutput } from 'rollup';
import type { InlineConfig } from 'vite';
import type { Configuration, Stats, StatsCompilation } from 'webpack';

export type BundlerOptions =
    | RspackOptions
    | Configuration
    | BuildOptions
    | RollupOptions
    | InlineConfig;
export type BundlerConfig = {
    workingDir: string;
    outDir: string;
    entry: { [name: string]: string };
    plugins?: any[];
};
export type BundlerConfigFunction = (config: BundlerConfig) => BundlerOptions;
export type BundlerRunFn = (bundlerConfig: any) => Promise<{ errors: string[]; result?: any }>;

const xpackCallback = (
    err: Error | null,
    stats: Stats | RspackStats | undefined,
    resolve: (value: unknown) => void,
    reject: (reason?: any) => void,
) => {
    if (err) {
        reject(err);
        return;
    }

    if (!stats) {
        reject('No stats returned.');
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

    resolve(stats);
};

export const buildWithRspack: BundlerRunFn = async (bundlerConfig: RspackOptions) => {
    const { rspack } = await import('@rspack/core');
    const errors = [];
    let result: RspackStatsCompilation | undefined;

    try {
        await new Promise((resolve, reject) => {
            rspack(bundlerConfig, (err, stats) => {
                result = stats?.toJson();
                xpackCallback(err, stats, resolve, reject);
            });
        });
    } catch (e: any) {
        errors.push(`[RSPACK] : ${e.message}`);
    }

    return { errors, result };
};

export const buildWithWebpack: BundlerRunFn = async (bundlerConfig: Configuration) => {
    const { default: webpack } = await import('webpack');
    const errors = [];
    let result: StatsCompilation | undefined;

    try {
        await new Promise((resolve, reject) => {
            webpack(bundlerConfig, (err, stats) => {
                result = stats?.toJson();
                xpackCallback(err, stats, resolve, reject);
            });
        });
    } catch (e: any) {
        errors.push(`[WEBPACK] : ${e.message}`);
    }

    return { errors, result };
};

export const buildWithEsbuild: BundlerRunFn = async (bundlerConfigs: BuildOptions) => {
    const { build } = await import('esbuild');
    let result: BuildResult | undefined;
    const errors = [];

    try {
        result = await build(bundlerConfigs);
    } catch (e: any) {
        errors.push(`[ESBUILD] : ${e.message}`);
    }

    // There's a slight delay to fully exit esbuild and trigger the onDispose hook.
    await new Promise<void>((resolve) => setTimeout(resolve, 1));

    return { errors, result };
};

export const buildWithVite: BundlerRunFn = async (bundlerConfig: InlineConfig) => {
    const vite = await import('vite');
    const errors = [];
    let result: Awaited<ReturnType<typeof vite.build>> | undefined;

    try {
        result = await vite.build(bundlerConfig);
    } catch (e: any) {
        errors.push(`[VITE] : ${e.message}`);
    }

    return { errors, result };
};

export const buildWithRollup: BundlerRunFn = async (bundlerConfig: RollupOptions) => {
    const { rollup } = await import('rollup');
    const errors = [];
    let results: RollupOutput[] | undefined;

    try {
        const result = await rollup(bundlerConfig);

        // Write out the results.
        if (bundlerConfig.output) {
            const outputProms: Promise<RollupOutput>[] = [];
            const outputOptions = Array.isArray(bundlerConfig.output)
                ? bundlerConfig.output
                : [bundlerConfig.output];
            for (const outputOption of outputOptions) {
                outputProms.push(
                    (async () => {
                        const bundleResult = await result.write(outputOption);
                        await result.close();
                        return bundleResult;
                    })(),
                );
            }

            results = await Promise.all(outputProms);
        }
    } catch (e: any) {
        errors.push(`[ROLLUP] : ${e.message}`);
    }

    return { errors, result: results };
};

export const configXpack = (config: BundlerConfig): Configuration & RspackOptions => {
    return {
        context: config.workingDir,
        entry: config.entry,
        mode: 'production',
        output: {
            path: config.outDir,
            filename: `[name].js`,
        },
        devtool: 'source-map',
        optimization: {
            minimize: false,
        },
        plugins: config.plugins,
    };
};

type ViteRollupOptions = NonNullable<InlineConfig['build']>['rollupOptions'];
const configRollupBase = (config: BundlerConfig): RollupOptions & ViteRollupOptions => {
    // Rollup doesn't have a working dir option.
    // So we change the entry name to include the working dir.
    const input: RollupOptions['input'] = {};
    for (const [name, entry] of Object.entries(config.entry)) {
        input[name] = path.resolve(config.workingDir, entry);
    }

    return {
        input,
        onwarn: (warning, handler) => {
            if (
                !/Circular dependency:/.test(warning.message) &&
                !/Sourcemap is likely to be incorrect/.test(warning.message)
            ) {
                return handler(warning);
            }
        },
        output: {
            chunkFileNames: 'chunk.[hash].js',
            compact: false,
            dir: config.outDir,
            entryFileNames: '[name].js',
            sourcemap: true,
        },
    };
};

export const configRspack = (config: BundlerConfig): RspackOptions => {
    return configXpack(config);
};

export const configWebpack = (config: BundlerConfig): Configuration => {
    return configXpack(config);
};

export const configEsbuild = (config: BundlerConfig): BuildOptions => {
    return {
        absWorkingDir: config.workingDir,
        bundle: true,
        chunkNames: 'chunk.[hash]',
        entryPoints: config.entry,
        entryNames: '[name]',
        format: 'cjs',
        outdir: config.outDir,
        sourcemap: true,
        splitting: false,
        plugins: config.plugins,
    };
};

export const configRollup = (config: BundlerConfig): RollupOptions => {
    const baseConfig = configRollupBase(config);
    return {
        ...baseConfig,
        plugins: [
            commonjs(),
            nodeResolve({ preferBuiltins: true, browser: true }),
            ...(config.plugins || []),
        ],
    };
};

export const configVite = (config: BundlerConfig): InlineConfig => {
    const baseConfig = configRollupBase({
        ...config,
        // Remove the plugins to only have Vite ones.
        plugins: undefined,
    });

    return {
        root: config.workingDir,
        build: {
            emptyOutDir: false,
            assetsDir: '', // Disable assets dir to simplify the test.
            minify: false,
            rollupOptions: baseConfig,
        },
        logLevel: 'silent',
        plugins: config.plugins,
    };
};

export const allBundlers: Record<
    BundlerName,
    { run: BundlerRunFn; config: BundlerConfigFunction }
> = {
    rspack: { run: buildWithRspack, config: configRspack },
    webpack: { run: buildWithWebpack, config: configWebpack },
    esbuild: { run: buildWithEsbuild, config: configEsbuild },
    vite: { run: buildWithVite, config: configVite },
    rollup: { run: buildWithRollup, config: configRollup },
};
