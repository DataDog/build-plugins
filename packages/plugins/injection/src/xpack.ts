// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, Logger, PluginOptions } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';

import { PLUGIN_NAME } from './constants';
import { getContentToInject } from './helpers';
import type { ContentsToInject, FilesToInject } from './types';

export const getWebpackPlugin =
    (
        bundler: any,
        log: Logger,
        context: GlobalContext,
        contentsToInject: ContentsToInject,
    ): PluginOptions['webpack'] =>
    (compiler) => {
        const BannerPlugin =
            compiler?.webpack?.BannerPlugin ||
            bundler?.BannerPlugin ||
            bundler?.default?.BannerPlugin;

        const ChunkGraph =
            compiler?.webpack?.ChunkGraph || bundler?.ChunkGraph || bundler?.default?.ChunkGraph;

        if (!BannerPlugin) {
            log.error('Missing BannerPlugin');
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
                        if (!chunkGraph || chunkGraph.getNumberOfEntryModules(data.chunk) === 0) {
                            return '';
                        }

                        return getContentToInject(contentsToInject[InjectPosition.BEFORE]);
                    } else {
                        if (!data.chunk?.hasEntryModule()) {
                            return '';
                        }

                        return getContentToInject(contentsToInject[InjectPosition.BEFORE]);
                    }
                },
            }),
        );
    };

export const getRspackPlugin =
    (
        log: Logger,
        getFilesToInject: () => FilesToInject,
        contentsToInject: ContentsToInject,
    ): PluginOptions['rspack'] =>
    (compiler) => {
        compiler.options.plugins = compiler.options.plugins || [];
        compiler.options.plugins.push(
            new compiler.rspack.BannerPlugin({
                // Not wrapped in comments.
                raw: true,
                // Only entry modules.
                entryOnly: true,
                banner(data) {
                    // entryOnly doesn't seem to work the way we think either.
                    if (
                        // chunkReason is the only way to know if it's an entry module.
                        data.chunk?.chunkReason ||
                        // Do not inject into hot-updates.
                        data.filename.includes('.hot-update.') ||
                        // Only inject into js files.
                        !data.filename.endsWith('.js')
                    ) {
                        return '';
                    }

                    return getContentToInject(contentsToInject[InjectPosition.BEFORE]);
                },
            }),
        );

        type Entry = typeof compiler.options.entry;
        const absolutePathToInject = getFilesToInject()[InjectPosition.MIDDLE].absolutePath;

        const injectEntry = (initialEntry: Entry): Entry => {
            const objectInjection = (entry: Entry) => {
                for (const entryValue of Object.values(entry)) {
                    entryValue.import = entryValue.import || [];
                    entryValue.import.unshift(absolutePathToInject);
                }
            };

            if (!initialEntry) {
                return {
                    ddHelper: {
                        import: [absolutePathToInject],
                    },
                };
            } else if (typeof initialEntry === 'function') {
                return async () => {
                    const originEntry = await initialEntry();
                    objectInjection(originEntry);
                    return originEntry;
                };
            } else if (typeof initialEntry === 'object') {
                objectInjection(initialEntry);
            } else {
                log.error(`Invalid entry type: ${typeof initialEntry}`);
                return initialEntry;
            }
            return initialEntry;
        };

        const newEntry = injectEntry(compiler.options.entry);

        compiler.options.entry = newEntry;
    };
