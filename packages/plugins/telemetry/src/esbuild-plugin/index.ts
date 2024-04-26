// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BuildResult } from 'esbuild';
import type { UnpluginOptions } from 'unplugin';

import { output } from '../common/output';
import type { Context, OptionsWithTelemetryEnabled } from '../types';

import { getModulesResults } from './modules';
import { wrapPlugins, getResults as getPluginsResults } from './plugins';

export const getEsbuildPlugin = (opt: OptionsWithTelemetryEnabled): UnpluginOptions['esbuild'] => {
    return {
        setup: (build) => {
            const startBuild = Date.now();
            // We force esbuild to produce its metafile.
            build.initialOptions.metafile = true;
            wrapPlugins(build, opt.cwd);
            build.onEnd(async (result: BuildResult) => {
                const { plugins, modules } = getPluginsResults();
                // We know it exists since we're setting the option earlier.
                const metaFile = result.metafile!;
                const moduleResults = getModulesResults(opt.cwd, metaFile);

                const context: Context = {
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

                await output(context, opt);
            });
        },
    };
};
