// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { FULL_NAME_BUNDLERS } from '@dd/core/constants';
import type { BundlerFullName, BundlerName } from '@dd/core/types';
import { bgYellow, dim, green, red } from '@dd/tools/helpers';

export const PLUGIN_VERSIONS: Record<BundlerName, string> = {
    esbuild: require('@datadog/esbuild-plugin').version,
    rollup: require('@datadog/rollup-plugin').version,
    rspack: require('@datadog/rspack-plugin').version,
    vite: require('@datadog/vite-plugin').version,
    webpack: require('@datadog/webpack-plugin').version,
};

export const BUNDLER_VERSIONS: Record<BundlerFullName, string> = {
    esbuild: require('esbuild').version,
    rspack: require('@rspack/core').version,
    rollup: require('rollup').VERSION,
    vite: require('vite').version,
    webpack4: require('webpack4').version,
    webpack5: require('webpack5').version,
};

// Handle --cleanup flag.
export const NO_CLEANUP = process.argv.includes('--cleanup=0');
if (NO_CLEANUP) {
    console.log(bgYellow(" Won't clean up "));
}

// Handle --build flag.
export const NEED_BUILD = process.argv.includes('--build=1');
if (NEED_BUILD) {
    console.log(bgYellow(' Will also build used plugins '));
}

// Handle --bundlers flag.
export const REQUESTED_BUNDLERS = process.argv.includes('--bundlers')
    ? process.argv[process.argv.indexOf('--bundlers') + 1].split(',')
    : process.argv
          .find((arg) => arg.startsWith('--bundlers='))
          ?.split('=')[1]
          .split(',') ?? [];

if (REQUESTED_BUNDLERS.length) {
    if (
        !(REQUESTED_BUNDLERS as BundlerFullName[]).every((bundler) =>
            FULL_NAME_BUNDLERS.includes(bundler),
        )
    ) {
        throw new Error(
            `Invalid "${red(`--bundlers ${REQUESTED_BUNDLERS.join(',')}`)}".\nValid bundlers are ${FULL_NAME_BUNDLERS.map(
                (b) => green(b),
            )
                .sort()
                .join(', ')}.`,
        );
    }
    const bundlersList = REQUESTED_BUNDLERS.map((bundler) => green(bundler)).join(', ');
    console.log(`Running ${bgYellow(' ONLY ')} for ${bundlersList}.`);
}

if (!NO_CLEANUP || !NEED_BUILD || REQUESTED_BUNDLERS.length) {
    const tips: string[] = [];
    if (!NO_CLEANUP) {
        tips.push(`  ${green('--cleanup=0')} to keep the built artifacts.`);
    }
    if (!NEED_BUILD) {
        tips.push(`  ${green('--build=1')} to force the build of the used plugins.`);
    }
    if (!REQUESTED_BUNDLERS.length) {
        tips.push(`  ${green('--bundlers=webpack4,esbuild')} to only use specified bundlers.`);
    }
    console.log(dim(`\nYou can also use : \n${tips.join('\n')}\n`));
}
