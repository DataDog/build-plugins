import { getLogger } from '@dd/core/log';
import type { Options, PluginOptions, ToInjectItem } from '@dd/core/types';

import {
    INJECTED_FILE,
    PLUGIN_NAME,
    PREPARATION_PLUGIN_NAME,
    RESOLUTION_PLUGIN_NAME,
} from './constants';
import { processInjections } from './helpers';

export const getInjectionPlugins = (opts: Options, toInject: ToInjectItem[]): PluginOptions[] => {
    const log = getLogger(opts.logLevel, PLUGIN_NAME);
    const contentToInject: string[] = [];

    // Rollup uses its own banner hook
    // and doesn't need to create a virtual INJECTED_FILE.
    // We use its native functionality.
    const rollupInjectionPlugin: PluginOptions['rollup'] = {
        banner(chunk) {
            if (chunk.isEntry) {
                return contentToInject.join('\n\n');
            }
            return '';
        },
    };

    // This plugin happens in 3 steps in order to cover all bundlers:
    //   1. Prepare the content to inject, fetching distant/local files and anything necessary.
    //   2. Inject a virtual file into the bundling, this file will be home of all injected content.
    //   3. Resolve the virtual file, returning the prepared injected content.
    return [
        // Prepare and fetch the content to inject.
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
        {
            name: PLUGIN_NAME,
            esbuild: {
                setup(build) {
                    const { initialOptions } = build;
                    initialOptions.inject = initialOptions.inject || [];
                    initialOptions.inject.push(INJECTED_FILE);
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
                        let injected = false;
                        for (const entryName in originalEntry) {
                            if (!Object.hasOwn(originalEntry, entryName)) {
                                continue;
                            }
                            const entry = originalEntry[entryName];
                            // FIXME: This is not working with webpack4.
                            const normalizedEntry =
                                typeof entry === 'string' ? { import: [entry] } : entry;
                            newEntry[entryName] = {
                                ...normalizedEntry,
                                import: [INJECTED_FILE, ...normalizedEntry.import],
                            };
                            injected = true;
                        }

                        if (!injected) {
                            return { [INJECTED_FILE]: { import: [INJECTED_FILE] } };
                        }

                        return newEntry;
                    }

                    return [INJECTED_FILE, originalEntry];
                };

                console.log(JSON.stringify(compiler.options.entry, null, 2));
                compiler.options.entry = injectEntry(compiler.options.entry);
                console.log(JSON.stringify(compiler.options.entry, null, 2));
            },
            rollup: rollupInjectionPlugin,
            vite: rollupInjectionPlugin,
        },
        // Resolve the injected file.
        {
            name: RESOLUTION_PLUGIN_NAME,
            enforce: 'post',
            resolveId(id) {
                if (id === INJECTED_FILE) {
                    return { id, moduleSideEffects: true };
                }
            },
            loadInclude(id) {
                return id === INJECTED_FILE;
            },
            load(id) {
                if (id === INJECTED_FILE) {
                    return contentToInject.join('\n\n');
                }
            },
        },
    ];
};
