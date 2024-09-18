// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getLogger } from '@dd/core/log';
import type { GlobalContext } from '@dd/core/types';
import type { BuildResult } from 'esbuild';
import type { UnpluginOptions } from 'unplugin';

import { validateOptions } from '../common/helpers';
import { output } from '../common/output';
import { sendMetrics } from '../common/sender';
import type { BundlerContext, OptionsWithTelemetry } from '../types';

import { getModulesResults } from './modules';
import { wrapPlugins, getResults as getPluginsResults } from './plugins';

export const getEsbuildPlugin = (
    opt: OptionsWithTelemetry,
    ctx: GlobalContext,
): UnpluginOptions['esbuild'] => {
    return {
        setup: (build) => {
            const startBuild = Date.now();
            const logger = getLogger(opt.logLevel, 'telemetry');
            const telemetryOptions = validateOptions(opt);
            // We force esbuild to produce its metafile.
            build.initialOptions.metafile = true;
            wrapPlugins(build, ctx.cwd);
            build.onEnd(async (result: BuildResult) => {
                const { plugins, modules } = getPluginsResults();
                // We know it exists since we're setting the option earlier.
                const metaFile = result.metafile!;
                const moduleResults = getModulesResults(ctx.cwd, metaFile);

                const bundlerContext: BundlerContext = {
                    start: startBuild,
                    report: {
                        timings: {
                            tapables: plugins,
                            modules,
                        },
                        dependencies: moduleResults,
                    },
                    bundler: {
                        esbuild: {
                            warnings: result.warnings,
                            errors: result.errors,
                            entrypoints: build.initialOptions.entryPoints,
                            duration: Date.now() - startBuild,
                            ...metaFile,
                        },
                    },
                };

                await output(bundlerContext, telemetryOptions, logger, ctx);
                await sendMetrics(bundlerContext.metrics, opt, logger);
            });
        },
    };
};
