// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import { outputFile, rm } from '@dd/core/helpers';
import type { GlobalContext, PluginOptions, ToInjectItem } from '@dd/core/types';
import path from 'path';

import { PLUGIN_NAME, PREPARATION_PLUGIN_NAME } from './constants';
import { processInjections } from './helpers';

export const getInjectionPlugins = (
    bundler: any,
    context: GlobalContext,
    toInject: ToInjectItem[],
): PluginOptions[] => {
    const log = context.getLogger(PLUGIN_NAME);
    const contentToInject: string[] = [];

    const getContentToInject = () => {
        // Needs a non empty string otherwise ESBuild will throw 'Do not know how to load path'.
        // Most likely because it tries to generate an empty file.
        const before = `
/********************************************/
/* BEGIN INJECTION BY DATADOG BUILD PLUGINS */`;
        const after = `
/*  END INJECTION BY DATADOG BUILD PLUGINS  */
/********************************************/`;

        return `${before}\n${contentToInject.join('\n\n')}\n${after}`;
    };

    // Rollup uses its own banner hook.
    // We use its native functionality.
    const rollupInjectionPlugin: PluginOptions['rollup'] = {
        banner(chunk) {
            if (chunk.isEntry) {
                return getContentToInject();
            }
            return '';
        },
    };

    // Create a unique filename to avoid conflicts.
    const INJECTED_FILE_PATH = `${Date.now()}.${performance.now()}.${INJECTED_FILE}.js`;

    // This plugin happens in 2 steps in order to cover all bundlers:
    //   1. Prepare the content to inject, fetching distant/local files and anything necessary.
    //       a. [esbuild] We also create the actual file for esbuild to avoid any resolution errors
    //            and keep the inject override safe.
    //       b. [esbuild] With a custom resolver, every client side sub-builds would fail to resolve
    //            the file when re-using the same config as the parent build (with the inject).
    //   2. Inject a virtual file into the bundling, this file will be home of all injected content.
    const plugins: PluginOptions[] = [
        // Prepare and fetch the content to inject for all bundlers.
        {
            name: PREPARATION_PLUGIN_NAME,
            enforce: 'pre',
            // We use buildStart as it is the first async hook.
            async buildStart() {
                const results = await processInjections(toInject, log);
                contentToInject.push(...results);

                // Only esbuild needs the following.
                if (context.bundler.name !== 'esbuild') {
                    return;
                }

                // We put it in the outDir to avoid impacting any other part of the build.
                // While still being under esbuild's cwd.
                const absolutePathInjectFile = path.resolve(
                    context.bundler.outDir,
                    INJECTED_FILE_PATH,
                );

                // Actually create the file to avoid any resolution errors.
                // It needs to be within cwd.
                try {
                    await outputFile(absolutePathInjectFile, getContentToInject());
                } catch (e: any) {
                    log(`Could not create the file: ${e.message}`, 'error');
                }
            },

            async buildEnd() {
                // Only esbuild needs the following.
                if (context.bundler.name !== 'esbuild') {
                    return;
                }

                const absolutePathInjectFile = path.resolve(
                    context.bundler.outDir,
                    INJECTED_FILE_PATH,
                );

                // Remove our assets.
                await rm(absolutePathInjectFile);
            },
        },
        // Inject the file that will be home of all injected content.
        // Each bundler has its own way to inject a file.
        {
            name: PLUGIN_NAME,
            esbuild: {
                setup(build) {
                    const { initialOptions } = build;
                    const absolutePathInjectFile = path.resolve(
                        context.bundler.outDir,
                        INJECTED_FILE_PATH,
                    );

                    // Inject the file in the build.
                    // This is made safe for sub-builds by actually creating the file.
                    initialOptions.inject = initialOptions.inject || [];
                    initialOptions.inject.push(absolutePathInjectFile);
                },
            },
            webpack: (compiler) => {
                const BannerPlugin =
                    compiler?.webpack?.BannerPlugin ||
                    bundler?.BannerPlugin ||
                    bundler?.default?.BannerPlugin;

                const ChunkGraph =
                    compiler?.webpack?.ChunkGraph ||
                    bundler?.ChunkGraph ||
                    bundler?.default?.ChunkGraph;

                if (!BannerPlugin) {
                    log('Missing BannerPlugin', 'error');
                }

                // Intercept the compilation's ChunkGraph
                let chunkGraph: InstanceType<typeof ChunkGraph>;
                compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
                    compilation.hooks.afterChunks.tap(PLUGIN_NAME, () => {
                        chunkGraph = compilation.chunkGraph;
                    });
                });

                compiler.options.plugins = compiler.options.plugins || [];
                compiler.options.plugins.push(
                    new BannerPlugin({
                        // Not wrapped in comments.
                        raw: true,
                        // Doesn't seem to work, but it's supposed to only add
                        // the banner to entry modules.
                        entryOnly: true,
                        banner(data) {
                            // In webpack5 we HAVE to use the chunkGraph.
                            if (context.bundler.variant === '5') {
                                if (
                                    !chunkGraph ||
                                    chunkGraph.getNumberOfEntryModules(data.chunk) === 0
                                ) {
                                    return '';
                                }

                                return getContentToInject();
                            } else {
                                if (!data.chunk?.hasEntryModule()) {
                                    return '';
                                }

                                return getContentToInject();
                            }
                        },
                    }),
                );
            },
            rollup: rollupInjectionPlugin,
            vite: rollupInjectionPlugin,
        },
    ];

    return plugins;
};
