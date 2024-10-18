// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getLogger } from '@dd/core/log';
import type { GlobalContext, Options, PluginOptions, ToInjectItem } from '@dd/core/types';
import fs from 'fs';
import path from 'path';

import { INJECTED_FILE_PATH, PLUGIN_NAME, PREPARATION_PLUGIN_NAME } from './constants';
import { processInjections } from './helpers';

export const getInjectionPlugins = (
    bundler: any,
    opts: Options,
    context: GlobalContext,
    toInject: ToInjectItem[],
): PluginOptions[] => {
    const log = getLogger(opts.logLevel, PLUGIN_NAME);
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

                const absolutePathInjectFile = path.resolve(
                    context.bundler.outDir,
                    INJECTED_FILE_PATH,
                );

                // Actually create the file to avoid any resolution errors.
                // It needs to be within cwd.
                try {
                    await fs.promises.mkdir(path.dirname(absolutePathInjectFile), {
                        recursive: true,
                    });
                    await fs.promises.writeFile(absolutePathInjectFile, getContentToInject());
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
                await fs.promises.rm(absolutePathInjectFile, {
                    force: true,
                    maxRetries: 3,
                    recursive: true,
                });
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

                if (!BannerPlugin) {
                    log('Missing BannerPlugin', 'error');
                }

                compiler.options.plugins = compiler.options.plugins || [];
                compiler.options.plugins.push(
                    new BannerPlugin({
                        // Not wrapped in comments.
                        raw: true,
                        // Not sure this is actually working, but it's supposed to only add
                        // the banner to entry modules.
                        entryOnly: true,
                        banner({ chunk }) {
                            // Double verify that we have an entryModule.
                            if (!chunk?.hasEntryModule()) {
                                return '';
                            }

                            return getContentToInject();
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
