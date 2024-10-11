// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { isInjectionFile } from '@dd/core/helpers';
import { getLogger } from '@dd/core/log';
import type { GlobalContext, Options, PluginOptions, ToInjectItem } from '@dd/core/types';
import path from 'path';

import {
    INJECTED_FILE,
    INJECTION_SUFFIX,
    PLUGIN_NAME,
    PREPARATION_PLUGIN_NAME,
    RESOLUTION_PLUGIN_NAME,
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

    // This plugin happens in 3 steps in order to cover all bundlers:
    //   1. Setup resolvers for the virtual file, returning the prepared injected content.
    //   2. Prepare the content to inject, fetching distant/local files and anything necessary.
    //   3. Inject a virtual file into the bundling, this file will be home of all injected content.
    return [
        // Resolve the injected file for all bundlers.
        {
            name: RESOLUTION_PLUGIN_NAME,
            enforce: 'pre',
            async resolveId(id) {
                if (isInjectionFile(id)) {
                    return { id, moduleSideEffects: true };
                }
            },
            loadInclude(id) {
                if (isInjectionFile(id)) {
                    return true;
                }
            },
            load(id) {
                if (isInjectionFile(id)) {
                    return getContentToInject();
                }
            },
        },
        // Prepare and fetch the content to inject for all bundlers.
        {
            name: PREPARATION_PLUGIN_NAME,
            enforce: 'pre',
            // We use buildStart as it is the first async hook.
            async buildStart() {
                const results = await processInjections(toInject, log);
                contentToInject.push(...results);
            },
        },
        // Inject the virtual file that will be home of all injected content.
        // Each bundler has its own way to inject a file.
        {
            name: PLUGIN_NAME,
            esbuild: {
                setup(build) {
                    const { initialOptions } = build;

                    build.onResolve({ filter: /.*/ }, async (args) => {
                        // Only mark the entry point for injection.
                        if (args.kind !== 'entry-point') {
                            return null;
                        }

                        // Injected modules via the esbuild `inject` option do also have `kind == "entry-point"`.
                        if (initialOptions.inject?.includes(args.path)) {
                            return null;
                        }

                        return {
                            pluginName: PLUGIN_NAME,
                            path: path.isAbsolute(args.path)
                                ? args.path
                                : path.join(args.resolveDir, args.path),
                            pluginData: {
                                isInjectionResolver: true,
                                originalPath: args.path,
                                originalResolveDir: args.resolveDir,
                            },
                            // Adding a suffix prevents esbuild from marking the entrypoint as resolved,
                            // avoiding a dependency loop with the proxy module.
                            // This ensures esbuild continues to traverse the module tree
                            // and re-resolves the entrypoint when imported from the proxy module.
                            suffix: INJECTION_SUFFIX,
                        };
                    });

                    build.onLoad({ filter: /.*/ }, async (args) => {
                        // We only want to handle the marked entry point.
                        if (!args.pluginData?.isInjectionResolver) {
                            return null;
                        }

                        const originalPath = args.pluginData.originalPath;
                        const originalResolveDir = args.pluginData.originalResolveDir;

                        // Using JSON.stringify to keep escaped backslashes (windows).
                        // Using ['default'.toString()] to bypass esbuild's import-is-undefined warning.
                        const contents = `
import ${JSON.stringify(INJECTED_FILE)};
import * as OriginalModule from ${JSON.stringify(originalPath)};
export default OriginalModule['default'.toString()];
export * from ${JSON.stringify(originalPath)};
`;

                        return {
                            loader: 'js',
                            pluginName: PLUGIN_NAME,
                            contents,
                            resolveDir: originalResolveDir,
                        };
                    });
                },
            },
            webpack: (compiler) => {
                const injectEntry = (originalEntry: any) => {
                    if (!originalEntry) {
                        return [INJECTED_FILE];
                    }

                    if (Array.isArray(originalEntry)) {
                        return [INJECTED_FILE, ...originalEntry];
                    }

                    if (typeof originalEntry === 'function') {
                        return async () => {
                            const originEntry = await originalEntry();
                            return [INJECTED_FILE, originEntry];
                        };
                    }

                    if (typeof originalEntry === 'string') {
                        return [INJECTED_FILE, originalEntry];
                    }

                    // We need to adjust the existing entries to import our injected file.
                    if (typeof originalEntry === 'object') {
                        const newEntry: typeof originalEntry = {};
                        if (Object.keys(originalEntry).length === 0) {
                            newEntry[INJECTED_FILE] =
                                // Webpack 4 and 5 have different entry formats.
                                context.bundler.variant === '5'
                                    ? { import: [INJECTED_FILE] }
                                    : INJECTED_FILE;
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
                                    ? [INJECTED_FILE, entry]
                                    : {
                                          ...entry,
                                          import: [INJECTED_FILE, ...entry.import],
                                      };
                        }

                        return newEntry;
                    }

                    return [INJECTED_FILE, originalEntry];
                };

                compiler.options.entry = injectEntry(compiler.options.entry);
            },
            rollup: rollupInjectionPlugin,
            vite: rollupInjectionPlugin,
        },
    ];
};
