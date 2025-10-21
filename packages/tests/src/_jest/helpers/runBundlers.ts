// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogRspackPlugin } from '@datadog/rspack-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { datadogWebpackPlugin } from '@datadog/webpack-plugin';
import { rm } from '@dd/core/helpers/fs';
import { getUniqueId } from '@dd/core/helpers/strings';
import type { BundlerName, Options } from '@dd/core/types';
import type { BundlerConfig } from '@dd/tools/bundlers';
import {
    buildWithEsbuild,
    buildWithRollup,
    buildWithRspack,
    buildWithVite,
    buildWithWebpack,
    configEsbuild,
    configRollup,
    configRspack,
    configVite,
    configWebpack,
} from '@dd/tools/bundlers';
import { buildPlugins, green } from '@dd/tools/helpers';
import type { RspackOptions } from '@rspack/core';
import type { BuildOptions } from 'esbuild';
import type { RollupOptions } from 'rollup';
import type { UserConfig } from 'vite';
import type { Configuration } from 'webpack';

import { PLUGIN_VERSIONS } from './constants';
import { getOutDir, prepareWorkingDir } from './env';
import { easyProjectEntry, defaultPluginOptions } from './mocks';
import type { Bundler, BundlerRunFunction, CleanupFn, RunResult } from './types';

type PartialBuildOverrides = Partial<BundlerConfig>;

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
    configuration: RspackOptions,
) => {
    const { errors } = await buildWithRspack(configuration);
    return getCleanupFunction('Rspack', [configuration.output?.path], errors, workingDir);
};

export const runWebpack: BundlerRunFunction = async (
    workingDir: string,
    configuration: Configuration,
) => {
    const { errors } = await buildWithWebpack(configuration);
    return getCleanupFunction('Webpack', [configuration.output?.path], errors, workingDir);
};

export const runEsbuild: BundlerRunFunction = async (
    workingDir: string,
    configuration: BuildOptions,
) => {
    const { errors } = await buildWithEsbuild(configuration);
    return getCleanupFunction('ESBuild', [configuration.outdir], errors, workingDir);
};

export const runVite: BundlerRunFunction = async (
    workingDir: string,
    configuration: UserConfig,
) => {
    const { errors } = await buildWithVite(configuration);

    const outdirs: (string | undefined)[] = [];
    if (Array.isArray(configuration.build?.rollupOptions?.output)) {
        outdirs.push(...configuration.build.rollupOptions.output.map((o) => o.dir));
    } else if (configuration.build?.rollupOptions?.output?.dir) {
        outdirs.push(configuration.build.rollupOptions.output.dir);
    }

    return getCleanupFunction('Vite', outdirs, errors, workingDir);
};

export const runRollup: BundlerRunFunction = async (
    workingDir: string,
    configuration: RollupOptions,
) => {
    const { errors } = await buildWithRollup(configuration);

    const outdirs: (string | undefined)[] = [];
    if (Array.isArray(configuration.output)) {
        outdirs.push(...configuration.output.map((o) => o.dir));
    } else if (configuration.output?.dir) {
        outdirs.push(configuration.output.dir);
    }

    return getCleanupFunction('Rollup', outdirs, errors, workingDir);
};

const allBundlers: Bundler[] = [
    {
        name: 'webpack',
        run: runWebpack,
        config: configWebpack,
        plugin: datadogWebpackPlugin,
        version: PLUGIN_VERSIONS.webpack,
    },
    {
        name: 'rspack',
        run: runRspack,
        config: configRspack,
        plugin: datadogRspackPlugin,
        version: PLUGIN_VERSIONS.rspack,
    },
    {
        name: 'esbuild',
        run: runEsbuild,
        config: configEsbuild,
        plugin: datadogEsbuildPlugin,
        version: PLUGIN_VERSIONS.esbuild,
    },
    {
        name: 'vite',
        run: runVite,
        config: configVite,
        plugin: datadogVitePlugin,
        version: PLUGIN_VERSIONS.vite,
    },
    {
        name: 'rollup',
        run: runRollup,
        config: configRollup,
        plugin: datadogRollupPlugin,
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

// Returns the resolved bundler's configuration, ready to be consumed by its build command.
export const getBundlerConfig = (
    bundlerName: BundlerName,
    workingDir: string,
    pluginOverrides: Partial<Options> = {},
    buildOverrides: PartialBuildOverrides = {},
) => {
    const bundler = allBundlers.find((b) => b.name === bundlerName);
    if (!bundler) {
        throw Error(`Unknown bundler: ${bundlerName}.`);
    }

    return bundler.config({
        workingDir,
        outDir: getOutDir(workingDir, bundler.name),
        entry: { main: easyProjectEntry },
        ...buildOverrides,
        plugins: [
            ...(buildOverrides.plugins || []),
            bundler.plugin({ ...defaultPluginOptions, ...pluginOverrides }),
        ],
    });
};

export const runBundlers = async (
    pluginOverrides: Partial<Options> = {},
    buildOverrides: PartialBuildOverrides = {},
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

    const runBundlerFunction = async (bundler: Bundler) => {
        return bundler.run(
            workingDir,
            getBundlerConfig(bundler.name, workingDir, pluginOverrides, buildOverrides),
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
