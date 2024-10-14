// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getLogger } from '@dd/core/log';
import type { GlobalContext, Options, PluginOptions, ToInjectItem } from '@dd/core/types';
import fs from 'fs';
import path from 'path';

import {
    INJECTED_FILE,
    INJECTED_FILE_PATH,
    PLUGIN_NAME,
    PREPARATION_PLUGIN_NAME,
} from './constants';
import { processInjections } from './helpers';

export const getInjectionPlugins = (
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
/* BEGIN INJECTION BY DATADOG BUILD PLUGINS */
console.log('Hello from injection');`;
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

    const injectedFileAbsolutePath = path.join(context.cwd, INJECTED_FILE_PATH);

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

                // Rollup and Vite are doing their own thing with their Banner Plugin.
                if (['rollup', 'vite'].includes(context.bundler.name)) {
                    return;
                }

                // Emit our actual injection file.
                this.emitFile({
                    type: 'asset',
                    name: INJECTED_FILE_PATH,
                    // Needs to be referenced somewhere to actually be emitted.
                    needsCodeReference: true,
                    fileName: injectedFileAbsolutePath,
                    source: getContentToInject(),
                });
            },
            async buildEnd() {
                // Rollup and Vite are doing their own thing with their Banner Plugin.
                if (['rollup', 'vite'].includes(context.bundler.name)) {
                    return;
                }
                // Remove our assets.
                await fs.promises.rm(injectedFileAbsolutePath, {
                    force: true,
                    maxRetries: 3,
                    recursive: true,
                });
            },
        },
        // Inject the virtual file that will be home of all injected content.
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
                const injectEntry = (originalEntry: any) => {
                    if (!originalEntry) {
                        return [injectedFileAbsolutePath];
                    }

                    if (Array.isArray(originalEntry)) {
                        return [injectedFileAbsolutePath, ...originalEntry];
                    }

                    if (typeof originalEntry === 'function') {
                        return async () => {
                            const originEntry = await originalEntry();
                            return [injectedFileAbsolutePath, originEntry];
                        };
                    }

                    if (typeof originalEntry === 'string') {
                        return [injectedFileAbsolutePath, originalEntry];
                    }

                    // We need to adjust the existing entries to import our injected file.
                    if (typeof originalEntry === 'object') {
                        const newEntry: typeof originalEntry = {};
                        if (Object.keys(originalEntry).length === 0) {
                            newEntry[INJECTED_FILE] =
                                // Webpack 4 and 5 have different entry formats.
                                context.bundler.variant === '5'
                                    ? { import: [injectedFileAbsolutePath] }
                                    : injectedFileAbsolutePath;
                            return newEntry;
                        }

                        for (const entryName in originalEntry) {
                            if (!Object.hasOwn(originalEntry, entryName)) {
                                continue;
                            }
                            const entry = originalEntry[entryName];
                            newEntry[entryName] =
                                // Webpack 4 and 5 have different entry formats.
                                typeof entry === 'string'
                                    ? [injectedFileAbsolutePath, entry]
                                    : {
                                          ...entry,
                                          import: [injectedFileAbsolutePath, ...entry.import],
                                      };
                        }

                        return newEntry;
                    }

                    return [injectedFileAbsolutePath, originalEntry];
                };

                compiler.options.entry = injectEntry(compiler.options.entry);
            },
            rollup: rollupInjectionPlugin,
            vite: rollupInjectionPlugin,
        },
    ];
};
