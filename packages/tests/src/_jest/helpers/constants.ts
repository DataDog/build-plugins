// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BundlerFullName, BundlerName } from '@dd/core/types';

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
