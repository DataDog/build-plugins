// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger, GlobalContext, PluginOptions } from '@dd/core/types';
import type { BundlerContext } from '@dd/telemetry-plugin/types';
import type { BuildResult } from 'esbuild';

import { wrapPlugins, getResults as getPluginsResults } from './plugins';

export const getEsbuildPlugin = (
    bundlerContext: BundlerContext,
    globalContext: GlobalContext,
    logger: Logger,
): PluginOptions['esbuild'] => {
    return {
        setup: (build) => {
            // We force esbuild to produce its metafile.
            build.initialOptions.metafile = true;
            const timeWrap = logger.time('wrapping plugins');
            wrapPlugins(build, globalContext.cwd);
            timeWrap.end();
            build.onEnd(async (result: BuildResult) => {
                if (!result.metafile) {
                    logger.warn("Missing metafile, can't proceed with modules data.");
                    return;
                }

                const timeResult = logger.time('getting plugins results');
                const { plugins, modules } = getPluginsResults();
                timeResult.end();

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
