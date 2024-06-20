// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { UnpluginOptions } from 'unplugin';

import type { GlobalContext, Meta, Options } from '../../types';

export const getGlobalContextPlugin = (opts: Options, meta: Meta) => {
    const globalContext: GlobalContext = {
        auth: opts.auth,
        cwd: process.cwd(),
        version: meta.version,
        bundler: {
            name: meta.framework,
        },
    };

    const globalContextPlugin: UnpluginOptions = {
        name: 'global-context-plugin',
        enforce: 'pre',
        esbuild: {
            setup(build) {
                globalContext.bundler.config = build.initialOptions;
            },
        },
        webpack(compiler) {
            globalContext.bundler.config = compiler.options;
        },
        vite: {
            options(options: any) {
                globalContext.bundler.config = options;
            },
        },
        rollup: {
            options(options: any) {
                globalContext.bundler.config = options;
            },
        },
        rspack(compiler) {
            globalContext.bundler.config = compiler.options;
        },
        farm: {
            configResolved(config: any) {
                globalContext.bundler.config = config;
            },
        },
    };

    return { globalContext, globalContextPlugin };
};
