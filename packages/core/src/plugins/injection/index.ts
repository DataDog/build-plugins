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

    // Rollup uses its own banner hook
    // and doesn't need to create a virtual INJECTED_FILE.
    // We use its native functionality.
    const rollupInjectionPlugin: PluginOptions['rollup'] = {
        banner(chunk) {
            if (chunk.isEntry) {
                return getContentToInject();
            }
            return '';
        },
    };
    const absolutePathInjectFile = path.join(context.cwd, INJECTED_FILE_PATH);

    // This plugin happens in 2 steps in order to cover all bundlers:
    //   1. Prepare the content to inject, fetching distant/local files and anything necessary.
    //   2. Inject a virtual file into the bundling, this file will be home of all injected content.
    return [
        // Prepare and fetch the content to inject for all bundlers.
        {
            name: PREPARATION_PLUGIN_NAME,
            enforce: 'pre',
            // We use buildStart as it is the first async hook.
            async buildStart() {
                const results = await processInjections(toInject, log);
                contentToInject.push(...results);

                // Only esbuild needs this.
                if (context.bundler.name !== 'esbuild') {
                    return;
                }

                // Create the file, to avoid any error.
                try {
                    fs.mkdirSync(path.dirname(absolutePathInjectFile), { recursive: true });
                    fs.writeFileSync(absolutePathInjectFile, '');
                } catch (e: any) {
                    log(`Could not create the file: ${e.message}`, 'error');
                }

                // Emit our actual injection file.
                this.emitFile({
                    type: 'asset',
                    name: INJECTED_FILE_PATH,
                    // Needs to be referenced somewhere to actually be emitted.
                    needsCodeReference: true,
                    fileName: INJECTED_FILE_PATH,
                    source: getContentToInject(),
                });
            },
            async buildEnd() {
                // Only esbuild needs this.
                if (context.bundler.name !== 'esbuild') {
                    return;
                }
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
                    // Inject the file in the build.
                    initialOptions.inject = initialOptions.inject || [];
                    initialOptions.inject.push(INJECTED_FILE_PATH);
                },
            },
            webpack: (compiler) => {
                const BannerPlugin =
                    compiler?.webpack?.BannerPlugin ||
                    bundler.BannerPlugin ||
                    bundler.default.BannerPlugin;

                if (!BannerPlugin) {
                    log('Missing BannerPlugin', 'error');
                }

                compiler.options.plugins = compiler.options.plugins || [];
                compiler.options.plugins.push(
                    new BannerPlugin({
                        raw: true,
                        entryOnly: true,
                        banner({ chunk }) {
                            // Double verify that we're in an entryModule.
                            if (!chunk?.entryModule) {
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
};
