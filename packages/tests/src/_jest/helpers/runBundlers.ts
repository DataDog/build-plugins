// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getUniqueId, rm } from '@dd/core/helpers';
import type { Options } from '@dd/core/types';
import {
    buildWithEsbuild,
    buildWithRollup,
    buildWithRspack,
    buildWithVite,
    buildWithWebpack4,
    buildWithWebpack5,
} from '@dd/tools/bundlers';
import { buildPlugins, green } from '@dd/tools/helpers';
import type { RspackOptions } from '@rspack/core';
import type { BuildOptions } from 'esbuild';
import type { RollupOptions } from 'rollup';
import type { Configuration as Configuration4 } from 'webpack4';
import type { Configuration } from 'webpack5';

import {
    getEsbuildOptions,
    getRollupOptions,
    getRspackOptions,
    getViteOptions,
    getWebpack4Options,
    getWebpack5Options,
} from './configBundlers';
import { PLUGIN_VERSIONS } from './constants';
import { prepareWorkingDir } from './env';
import type {
    Bundler,
    BundlerRunFunction,
    CleanupFn,
    BundlerOverrides,
    CleanupEverythingFn,
} from './types';

// Get the environment variables.
const { NO_CLEANUP, NEED_BUILD, REQUESTED_BUNDLERS } = process.env;

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
    workingDir: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<RspackOptions> = {},
) => {
    const bundlerConfigs = getRspackOptions(workingDir, pluginOverrides, bundlerOverrides);
    const { errors } = await buildWithRspack(bundlerConfigs);
    return { cleanup: getCleanupFunction('Rspack', [bundlerConfigs.output?.path]), errors };
};

export const runWebpack5: BundlerRunFunction = async (
    workingDir: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<Configuration> = {},
) => {
    const bundlerConfigs = getWebpack5Options(workingDir, pluginOverrides, bundlerOverrides);
    const { errors } = await buildWithWebpack5(bundlerConfigs);
    return { cleanup: getCleanupFunction('Webpack 5', [bundlerConfigs.output?.path]), errors };
};

export const runWebpack4: BundlerRunFunction = async (
    workingDir: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<Configuration4> = {},
) => {
    const bundlerConfigs = getWebpack4Options(workingDir, pluginOverrides, bundlerOverrides);
    const { errors } = await buildWithWebpack4(bundlerConfigs);
    return { cleanup: getCleanupFunction('Webpack 4', [bundlerConfigs.output?.path]), errors };
};

export const runEsbuild: BundlerRunFunction = async (
    workingDir: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<BuildOptions> = {},
) => {
    const bundlerConfigs = getEsbuildOptions(workingDir, pluginOverrides, bundlerOverrides);
    const { errors } = await buildWithEsbuild(bundlerConfigs);
    return { cleanup: getCleanupFunction('ESBuild', [bundlerConfigs.outdir]), errors };
};

export const runVite: BundlerRunFunction = async (
    workingDir: string,
    pluginOverrides: Options = {},
    bundlerOverrides: Partial<RollupOptions> = {},
) => {
    const bundlerConfigs = getViteOptions(workingDir, pluginOverrides, bundlerOverrides);
    const { errors } = await buildWithVite(bundlerConfigs);

    const outdirs: (string | undefined)[] = [];
    if (Array.isArray(bundlerConfigs.build?.rollupOptions?.output)) {
        outdirs.push(...bundlerConfigs.build.rollupOptions.output.map((o) => o.dir));
    } else if (bundlerConfigs.build?.rollupOptions?.output?.dir) {
        outdirs.push(bundlerConfigs.build.rollupOptions.output.dir);
    }

    return { cleanup: getCleanupFunction('Vite', outdirs), errors };
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
    const bundlersToBuild = BUNDLERS.map(({ name }) => name);
    console.log(`[BUILD] Building ${green(bundlersToBuild.join(', '))}...`);
    buildPlugins(bundlersToBuild);
    console.log(`[BUILD] Done.`);
}

export const runBundlers = async (
    pluginOverrides: Partial<Options> = {},
    bundlerOverrides?: BundlerOverrides,
    bundlers?: string[],
): Promise<CleanupEverythingFn> => {
    const errors: string[] = [];

    // Generate a seed to avoid collision of builds.
    const seed: string = `${jest.getSeed()}.${getUniqueId()}`;

    const bundlersToRun = BUNDLERS.filter(
        (bundler) => !bundlers || bundlers.includes(bundler.name),
    );

    const workingDir = await prepareWorkingDir(seed);

    const bundlerOverridesResolved =
        typeof bundlerOverrides === 'function'
            ? bundlerOverrides(workingDir)
            : bundlerOverrides || {};

    const runBundlerFunction = async (bundler: Bundler) => {
        const bundlerOverride = bundlerOverridesResolved[bundler.name] || {};

        let result: Awaited<ReturnType<BundlerRunFunction>>;
        // Isolate each runs to avoid conflicts between tests.
        await jest.isolateModulesAsync(async () => {
            result = await bundler.run(workingDir, pluginOverrides, bundlerOverride);
        });
        return result!;
    };

    // Run the bundlers sequentially to ease the resources usage.
    const results = [];
    for (const bundler of bundlersToRun) {
        // eslint-disable-next-line no-await-in-loop
        results.push(await runBundlerFunction(bundler));
    }
    errors.push(...results.map((result) => result.errors).flat());

    const cleanupEverything = async () => {
        try {
            // Cleanup working directory.
            await getCleanupFunction('Root', [workingDir])();
        } catch (e) {
            console.error('Error during cleanup', e);
        }
    };

    cleanupEverything.errors = errors;
    cleanupEverything.workingDir = workingDir;

    // Return a cleanUp function.
    return cleanupEverything;
};
