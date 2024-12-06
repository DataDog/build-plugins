// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, Logger, PluginOptions, ToInjectItem } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import { createRequire } from 'module';

import { PLUGIN_NAME } from './constants';
import { getContentToInject, addInjections, createFiles } from './helpers';
import type { ContentsToInject, FilesToInject } from './types';

// A way to get the correct ConcatSource from either the bundler (rspack and webpack 5)
// or from 'webpack-sources' for webpack 4.
const getConcatSource = (bundler: any): typeof import('webpack-sources').ConcatSource => {
    if (!bundler?.sources?.ConcatSource) {
        // We need to require it as if we were "webpack", hence the createRequire from 'webpack'.
        // This way, we don't have to declare them in our (peer)dependencies and always use the one
        // that is compatible with the 'webpack' we're currently using.
        const webpackRequire = createRequire(require.resolve('webpack'));
        return webpackRequire('webpack-sources').ConcatSource;
    }
    return bundler.sources.ConcatSource;
};

export const getXpackPlugin =
    (
        bundler: any,
        log: Logger,
        context: GlobalContext,
        toInject: Map<string, ToInjectItem>,
        getFilesToInject: () => FilesToInject,
        contentsToInject: ContentsToInject,
    ): PluginOptions['rspack'] & PluginOptions['webpack'] =>
    (compiler) => {
        const cache = new WeakMap();
        const ConcatSource = getConcatSource(bundler);

        // Handle the InjectPosition.MIDDLE.
        type Entry = typeof compiler.options.entry;
        const injectEntry = (initialEntry: Entry): Entry => {
            const isWebpack4 = context.bundler.fullName === 'webpack4';
            const filePath = getFilesToInject()[InjectPosition.MIDDLE].absolutePath;

            // Webpack 4 doesn't support the "import" property.
            const injectedEntry = isWebpack4
                ? filePath
                : {
                      import: [filePath],
                  };

            const objectInjection = (entry: Entry) => {
                for (const [entryKey, entryValue] of Object.entries(entry)) {
                    if (typeof entryValue === 'object') {
                        entryValue.import = entryValue.import || [];
                        entryValue.import.unshift(filePath);
                    } else if (typeof entryValue === 'string') {
                        // @ts-expect-error - Badly typed for strings.
                        entry[entryKey] = [filePath, entryValue];
                    } else if (Array.isArray(entryValue)) {
                        entryValue.unshift(filePath);
                    } else {
                        log.error(`Invalid entry type: ${typeof entryValue}`);
                    }
                }
            };

            if (!initialEntry) {
                return {
                    // @ts-expect-error - Badly typed for strings.
                    ddHelper: injectedEntry,
                };
            } else if (typeof initialEntry === 'function') {
                // @ts-expect-error - This is webpack / rspack typing conflict.
                return async () => {
                    const originEntry = await initialEntry();
                    objectInjection(originEntry);
                    return originEntry;
                };
            } else if (typeof initialEntry === 'object') {
                objectInjection(initialEntry);
            } else if (typeof initialEntry === 'string') {
                // @ts-expect-error - Badly typed for strings.
                return [injectedEntry, initialEntry];
            } else {
                log.error(`Invalid entry type: ${typeof initialEntry}`);
                return initialEntry;
            }
            return initialEntry;
        };

        const newEntry = injectEntry(compiler.options.entry);
        // We inject the new entry.
        compiler.options.entry = newEntry;

        compiler.hooks.beforeRun.tapPromise(PLUGIN_NAME, async () => {
            // Prepare the injections.
            await addInjections(log, toInject, contentsToInject);

            try {
                // Actually create the files to avoid any resolution errors.
                await createFiles(log, getFilesToInject);
            } catch (e: any) {
                log.error(`Could not create the files: ${e.message}`);
            }
        });

        // Handle the InjectPosition.START and InjectPosition.END.

        // This is a re-implementation of the BannerPlugin,
        // that is compatible with all versions of webpack and rspack,
        // with both banner and footer.
        compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation) => {
            const hookCb = () => {
                const banner = getContentToInject(contentsToInject[InjectPosition.BEFORE]);
                const footer = getContentToInject(contentsToInject[InjectPosition.AFTER]);

                for (const chunk of compilation.chunks) {
                    if (!chunk.canBeInitial()) {
                        continue;
                    }

                    for (const file of chunk.files) {
                        compilation.updateAsset(file, (old) => {
                            const cached = cache.get(old);

                            // If anything changed, we need to re-create the source.
                            if (!cached || cached.banner !== banner || cached.footer !== footer) {
                                const source = new ConcatSource(
                                    banner,
                                    '\n',
                                    // @ts-expect-error - This is webpack / rspack typing conflict.
                                    old,
                                    '\n',
                                    footer,
                                );

                                // Cache the result.
                                cache.set(old, { source, banner, footer });
                                return source;
                            }

                            return cached.source;
                        });
                    }
                }
            };

            if (compilation.hooks.processAssets) {
                const stage = bundler.Compilation.PROCESS_ASSETS_STAGE_ADDITIONS;
                compilation.hooks.processAssets.tap({ name: PLUGIN_NAME, stage }, hookCb);
            } else {
                // @ts-expect-error - "optimizeChunkAssets" is for webpack 4.
                compilation.hooks.optimizeChunkAssets.tap({ name: PLUGIN_NAME }, hookCb);
            }
        });
    };
