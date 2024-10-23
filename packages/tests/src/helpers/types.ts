// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BundlerFullName, Options } from '@dd/core/types';
import type { BuildOptions } from 'esbuild';
import type { RollupOptions } from 'rollup';
import type { Configuration as Configuration4 } from 'webpack4';
import type { Configuration } from 'webpack5';

export type BundlerOverrides = {
    rollup?: Partial<RollupOptions>;
    vite?: Partial<RollupOptions>;
    esbuild?: Partial<BuildOptions>;
    webpack5?: Partial<Configuration>;
    webpack4?: Partial<Configuration4>;
};

export type Bundler = {
    name: BundlerFullName;
    // TODO: Better type this without "any".
    config: (seed: string, pluginOverrides: Partial<Options>, bundlerOverrides: any) => any;
    run: BundlerRunFunction;
    version: string;
};

export type CleanupFn = () => Promise<void>;
export type BundlerRunFunction = (
    seed: string,
    pluginOverrides: Options,
    bundlerOverrides: any,
) => Promise<{ cleanup: CleanupFn; errors: string[] }>;
