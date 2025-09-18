// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import { getUniqueId } from '@dd/core/helpers/strings';
import type { Options } from '@dd/core/types';
import {
    buildWithEsbuild,
    buildWithRollup,
    buildWithRspack,
    buildWithVite,
    buildWithWebpack,
} from '@dd/tools/bundlers';
import { buildPlugins, green } from '@dd/tools/helpers';
import type { RspackOptions } from '@rspack/core';
import type { BuildOptions } from 'esbuild';
import type { RollupOptions } from 'rollup';
import type { InlineConfig } from 'vite';
import type { Configuration } from 'webpack';

import {
    getEsbuildOptions,
    getRollupOptions,
    getRspackOptions,
    getViteOptions,
    getWebpackOptions,
} from './configBundlers';
import { PLUGIN_VERSIONS } from './constants';
import { prepareWorkingDir } from './env';
import type { Bundler, BundlerRunFunction, CleanupFn, BundlerOverrides, RunResult } from './types';

// Get the environment variables.
const { NO_CLEANUP, NEED_BUILD, REQUESTED_BUNDLERS } = process.env;

// A list of all the cleanup functions that will need to be run at the end of the tests.
const cleanups: CleanupFn[] = [];
// Run the global cleaning of temp working dirs.
// It is used in an `afterAll` hook in ./setupAfterEnv.ts.
export const cleanupEverything = async () => {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
};

const getCleanupFunction = (
    bundlerName: string,
    outdirs: (string | undefined)[],
    errors: string[],
    workingDir: string,
): CleanupFn => {
    const cleanup = async () => {
        // Remove self from the cleanups array.
        const remove = () => {
            const index = cleanups.indexOf(cleanup);
            if (index > -1) {
                cleanups.splice(index, 1);
            }
        };

        // We don't want to clean up in debug mode.
        if (NO_CLEANUP) {
            // Still remove the cleanup function from our list.
            remove();
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
        remove();
    };

    cleanup.errors = errors;
    cleanup.workingDir = workingDir;

    // Store it in the cleanups array.
    cleanups.push(cleanup);

    return cleanup;
};

export const runRspack: BundlerRunFunction = async (
    workingDir: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<RspackOptions> = {},
) => {
    const bundlerConfigs = getRspackOptions(workingDir, pluginOverrides, bundlerOverrides);
    const { errors } = await buildWithRspack(bundlerConfigs);
    return getCleanupFunction('Rspack', [bundlerConfigs.output?.path], errors, workingDir);
};

export const runWebpack: BundlerRunFunction = async (
    workingDir: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<Configuration> = {},
) => {
    const bundlerConfigs = getWebpackOptions(workingDir, pluginOverrides, bundlerOverrides);
    const { errors } = await buildWithWebpack(bundlerConfigs);
    return getCleanupFunction('Webpack', [bundlerConfigs.output?.path], errors, workingDir);
};

export const runEsbuild: BundlerRunFunction = async (
    workingDir: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<BuildOptions> = {},
) => {
    const bundlerConfigs = getEsbuildOptions(workingDir, pluginOverrides, bundlerOverrides);
    const { errors } = await buildWithEsbuild(bundlerConfigs);
    return getCleanupFunction('ESBuild', [bundlerConfigs.outdir], errors, workingDir);
};

export const runVite: BundlerRunFunction = async (
    workingDir: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<NonNullable<InlineConfig['build']>['rollupOptions']> = {},
) => {
    const bundlerConfigs = getViteOptions(workingDir, pluginOverrides, bundlerOverrides);
    const { errors } = await buildWithVite(bundlerConfigs);

    const outdirs: (string | undefined)[] = [];
    if (Array.isArray(bundlerConfigs.build?.rollupOptions?.output)) {
        outdirs.push(...bundlerConfigs.build.rollupOptions.output.map((o) => o.dir));
    } else if (bundlerConfigs.build?.rollupOptions?.output?.dir) {
        outdirs.push(bundlerConfigs.build.rollupOptions.output.dir);
    }

    return getCleanupFunction('Vite', outdirs, errors, workingDir);
};

export const runRollup: BundlerRunFunction = async (
    workingDir: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<RollupOptions> = {},
) => {
    const bundlerConfigs = getRollupOptions(workingDir, pluginOverrides, bundlerOverrides);
    const { errors } = await buildWithRollup(bundlerConfigs);

    const outdirs: (string | undefined)[] = [];
    if (Array.isArray(bundlerConfigs.output)) {
        outdirs.push(...bundlerConfigs.output.map((o) => o.dir));
    } else if (bundlerConfigs.output?.dir) {
        outdirs.push(bundlerConfigs.output.dir);
    }

    return getCleanupFunction('Rollup', outdirs, errors, workingDir);
};

const allBundlers: Bundler[] = [
    {
        name: 'webpack',
        run: runWebpack,
        config: getWebpackOptions,
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
    const bundlersToBuild = BUNDLERS.map(({ name }) => name);
    console.log(`[BUILD] Building ${green(bundlersToBuild.join(', '))}...`);
    buildPlugins(bundlersToBuild);
    console.log(`[BUILD] Done.`);
}

export const runBundlers = async (
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides?: BundlerOverrides,
    bundlers?: string[],
): Promise<RunResult> => {
    const errors: string[] = [];

    // Generate a seed to avoid collision of builds.
    const seed: string = `${Math.abs(jest.getSeed())}.${getUniqueId()}`;

    const bundlersToRun = BUNDLERS.filter(
        (bundler) => !bundlers || bundlers.includes(bundler.name),
    );

    const workingDir = await prepareWorkingDir(seed);

    if (NO_CLEANUP) {
        console.log(`[NO_CLEANUP] Working directory: ${workingDir}`);
    }

    const bundlerOverridesResolved =
        typeof bundlerOverrides === 'function'
            ? bundlerOverrides(workingDir)
            : bundlerOverrides || {};

    const runBundlerFunction = async (bundler: Bundler) => {
        return bundler.run(
            workingDir,
            pluginOverrides,
            bundlerOverridesResolved[bundler.name] || {},
        );
    };

    // Run the bundlers sequentially to ease the resources usage.
    const results = [];
    for (const bundler of bundlersToRun) {
        // eslint-disable-next-line no-await-in-loop
        results.push(await runBundlerFunction(bundler));
    }
    errors.push(...results.map((result) => result.errors).flat());

    // Return a cleanUp function.
    return { errors, workingDir };
};
