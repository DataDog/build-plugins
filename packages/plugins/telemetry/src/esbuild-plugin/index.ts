// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/log';
import type { GlobalContext } from '@dd/core/types';
import type { BuildResult } from 'esbuild';
import type { UnpluginOptions } from 'unplugin';

import type { BundlerContext } from '../types';

import { wrapPlugins, getResults as getPluginsResults } from './plugins';

export const getEsbuildPlugin = (
    bundlerContext: BundlerContext,
    globalContext: GlobalContext,
    logger: Logger,
): UnpluginOptions['esbuild'] => {
    return {
        setup: (build) => {
            globalContext.build.start = Date.now();

            // We force esbuild to produce its metafile.
            build.initialOptions.metafile = true;
            wrapPlugins(build, globalContext.cwd);
            build.onEnd(async (result: BuildResult) => {
                if (!result.metafile) {
                    logger("Missing metafile, can't proceed with modules data.", 'warn');
                    return;
                }

                const { plugins, modules } = getPluginsResults();

                bundlerContext.report = {
                    timings: {
                        tapables: plugins,
                        modules,
                    },
                };
            });
        },
    };
};
