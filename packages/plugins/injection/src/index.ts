// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import { getUniqueId, outputFile, readFileSafeSync, rm } from '@dd/core/helpers';
import {
    InjectPosition,
    type GlobalContext,
    type Logger,
    type Options,
    type PluginOptions,
    type ToInjectItem,
} from '@dd/core/types';
import path from 'path';

import { PLUGIN_NAME, PREPARATION_PLUGIN_NAME } from './constants';
import { processInjections } from './helpers';

export { PLUGIN_NAME } from './constants';

const BUNDLERS_THAT_NEED_FILE = ['rspack', 'esbuild'];
const needsFile = (bundler: string) => BUNDLERS_THAT_NEED_FILE.includes(bundler);

const getContentToInject = (contentToInject: Map<string, string>) => {
    // Needs a non empty string otherwise ESBuild will throw 'Do not know how to load path'.
    // Most likely because it tries to generate an empty file.
    const before = `
/********************************************/
/* BEGIN INJECTION BY DATADOG BUILD PLUGINS */`;
    const after = `
/*  END INJECTION BY DATADOG BUILD PLUGINS  */
/********************************************/`;
    const stringToInject = Array.from(contentToInject.values()).join('\n\n');

    return `${before}\n${stringToInject}\n${after}`;
};

export const getInjectionPlugins = (
    bundler: any,
    options: Options,
    context: GlobalContext,
    toInject: Map<string, ToInjectItem>,
    log: Logger,
): PluginOptions[] => {
    const contentsToInject: Record<InjectPosition, Map<string, string>> = {
        [InjectPosition.BEFORE]: new Map(),
        [InjectPosition.MIDDLE]: new Map(),
        [InjectPosition.AFTER]: new Map(),
    };

    // Rollup uses its own banner hook.
    // We use its native functionality.
    const rollupInjectionPlugin: PluginOptions['rollup'] = {
        banner(chunk) {
            if (chunk.isEntry) {
                return getContentToInject(contentsToInject[InjectPosition.BEFORE]);
            }
            return '';
        },
    };

    // Create unique filenames to avoid conflicts.
    const positionsToInject = [InjectPosition.BEFORE, InjectPosition.MIDDLE, InjectPosition.AFTER];
    const fileNames = Object.fromEntries(
        positionsToInject.map((position) => [
            position,
            `${getUniqueId()}.${position}.${INJECTED_FILE}.js`,
        ]),
    );
    const getFilesToInject = () => {
        return Object.fromEntries(
            positionsToInject.map((position) => [
                position,
                {
                    // We put it in the outDir to avoid impacting any other part of the build.
                    // While still being under esbuild's cwd.
                    absolutePath: path.resolve(context.bundler.outDir, fileNames[position]),
                    filename: fileNames[position],
                    toInject: contentsToInject[position],
                },
            ]),
        );
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
                // Redistribute the content to inject in the right place.
                for (const [id, value] of results.entries()) {
                    contentsToInject[value.position].set(id, value.value);
                }

                if (!needsFile(context.bundler.name)) {
                    return;
                }

                const filesToInject = getFilesToInject();

                // Actually create the files to avoid any resolution errors.
                // NOTE: It needs to be within cwd or it will fail in some bundlers.
                try {
                    const proms = [];
                    for (const file of Object.values(filesToInject)) {
                        // Verify that the file doesn't already exist.
                        const existingContent = readFileSafeSync(file.absolutePath);
                        const contentToInject = getContentToInject(file.toInject);

                        if (existingContent) {
                            log.warn(`Temporary file "${file.filename}" already exists.`);

                            // No need to write into the file if the content is the same.
                            // This is to prevent to trigger a re-build in dev mode.
                            if (existingContent.trim() === contentToInject.trim()) {
                                return;
                            } else {
                                log.debug(`Update temporary file "${file.filename}".`);
                            }
                        } else {
                            log.debug(`Create temporary file "${file.filename}".`);
                        }

                        proms.push(outputFile(file.absolutePath, contentToInject));
                    }

                    // Wait for all the files to be created.
                    await Promise.all(proms);
                } catch (e: any) {
                    log.error(`Could not create the files: ${e.message}`);
                }
            },

            async buildEnd() {
                if (!needsFile(context.bundler.name) || options.devServer) {
                    // TODO: Find a way to clean the file in devServer mode.
                    return;
                }

                const filesToInject = getFilesToInject();
                const proms = [];

                for (const file of Object.values(filesToInject)) {
                    // Remove our assets.
                    log.debug(`Removing temporary file "${file.filename}".`);
                    proms.push(rm(file.absolutePath));
                }

                await Promise.all(proms);
            },
        },
        // Inject the file that will be home of all injected content.
        // Each bundler has its own way to inject a file.
        {
            name: PLUGIN_NAME,
            esbuild: {
                setup(build) {
                    const { initialOptions } = build;

                    const filesToInject = getFilesToInject();

                    // Inject the file in the build.
                    // NOTE: This is made "safer" for sub-builds by actually creating the file.
                    initialOptions.inject = initialOptions.inject || [];
                    initialOptions.inject.push(filesToInject[InjectPosition.BEFORE].absolutePath);
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
                                if (
                                    !chunkGraph ||
                                    chunkGraph.getNumberOfEntryModules(data.chunk) === 0
                                ) {
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
            },
            rspack: (compiler) => {
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
            },
            rollup: rollupInjectionPlugin,
            vite: rollupInjectionPlugin,
        },
    ];

    return plugins;
};
