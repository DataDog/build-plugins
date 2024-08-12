// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/log';
import type { GlobalContext } from '@dd/core/types';
import type { BuildResult } from 'esbuild';
import type { UnpluginOptions } from 'unplugin';

import { output } from '../common/output';
import { sendMetrics } from '../common/sender';
import type { BundlerContext, TelemetryOptions } from '../types';

import { getModulesResults } from './modules';
import { wrapPlugins, getResults as getPluginsResults } from './plugins';

export const getEsbuildPlugin = (
    bundlerContext: BundlerContext,
    globalContext: GlobalContext,
    telemetryOptions: TelemetryOptions,
    logger: Logger,
): UnpluginOptions['esbuild'] => {
    return {
        setup: (build) => {
            globalContext.build.start = Date.now();

            // We force esbuild to produce its metafile.
            build.initialOptions.metafile = true;
            wrapPlugins(build, globalContext.cwd);
            build.onEnd(async (result: BuildResult) => {
                globalContext.build.end = Date.now();
                globalContext.build.duration = globalContext.build.end - globalContext.build.start!;

                const { plugins, modules } = getPluginsResults();
                // We know it exists since we're setting the option earlier.
                const metaFile = result.metafile!;
                const moduleResults = getModulesResults(globalContext.cwd, metaFile);

                bundlerContext.report = {
                    timings: {
                        tapables: plugins,
                        modules,
                    },
                    dependencies: moduleResults,
                };
                bundlerContext.bundler = { esbuild: metaFile };

                await output(bundlerContext, globalContext, telemetryOptions, logger);
                await sendMetrics(
                    bundlerContext.metrics,
                    { apiKey: globalContext.auth?.apiKey, endPoint: telemetryOptions.endPoint },
                    logger,
                );
            });
        },
    };
};
