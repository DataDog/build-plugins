// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { UnpluginContextMeta, UnpluginOptions } from 'unplugin';

export type Context = {
    cwd: string;
    version: string;
    bundler: {
        name: string;
        config?: any;
    };
};

export type Meta = UnpluginContextMeta & {
    version: string;
};

export const getCrossHelpersPlugin = (meta: Meta) => {
    const context: Context = {
        cwd: process.cwd(),
        version: meta.version,
        bundler: {
            name: meta.framework,
        },
    };

    const plugin: UnpluginOptions = {
        name: 'cross-helpers-plugin',
        esbuild: {
            setup(build) {
                context.bundler.config = build.initialOptions;
            },
        },
        webpack(compiler) {
            context.bundler.config = compiler.options;
        },
        vite: {
            options(options: any) {
                context.bundler.config = options;
            },
        },
        rollup: {
            options(options: any) {
                context.bundler.config = options;
            },
        },
        rspack(compiler) {
            context.bundler.config = compiler.options;
        },
        farm: {
            configResolved(config: any) {
                context.bundler.config = config;
            },
        },
    };

    return { context, plugin };
};
