// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getAbsolutePath } from '@dd/core/helpers/paths';
import type { GlobalContext, PluginOptions } from '@dd/core/types';
import fs from 'fs';
import path from 'path';

import { EARLY_COLLECTION_PLUGIN_NAME, PLUGIN_NAME } from '../constants';

import { getNoHtmlWarning, injectEarlyCollectionTag, isHtmlFile } from './html';
import type { InjectionResult } from './html';

const fsp = fs.promises;

// Mutable tally of what we saw in a build, to warn when there was no HTML to inject into.
type Tally = { seen: number; injected: number };

const record = (tally: Tally, result: InjectionResult | undefined) => {
    if (result) {
        tally.seen++;
        if (result.injected) {
            tally.injected++;
        }
    }
};

const toText = (source: string | Uint8Array | Buffer): string =>
    typeof source === 'string' ? source : Buffer.from(source).toString('utf-8');

const findHtmlFiles = async (dir: string): Promise<string[]> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = await Promise.all(
        entries.map((entry) => {
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                return entry.name === 'node_modules' ? [] : findHtmlFiles(entryPath);
            }
            return isHtmlFile(entry.name) ? [entryPath] : [];
        }),
    );
    return files.flat();
};

/**
 * Inject the early collection script (hosted on the browser agent CDN) as the first
 * script of the <head> of the HTML pages of the build, so it runs before the RUM SDK
 * and before the application code.
 *
 * The plugins never generate HTML themselves, so we post-process the HTML assets
 * produced by the build, whatever tool produced them:
 * - Vite: transformIndexHtml (build and dev server).
 * - webpack / rspack: processAssets, after html-webpack-plugin / HtmlRspackPlugin emitted.
 * - Rollup: generateBundle on the HTML assets emitted by other plugins.
 * - esbuild: HTML files found in the output directory once the build ends (best effort,
 *   it depends on the HTML having been written by then).
 */
export const getEarlyCollectionPlugin = (bundler: any, context: GlobalContext): PluginOptions => {
    const log = context.getLogger(PLUGIN_NAME);
    const warnNoHtml = () => log.warn(getNoHtmlWarning());

    const plugin: PluginOptions = {
        name: EARLY_COLLECTION_PLUGIN_NAME,
    };

    let isViteBuild = false;
    let viteHtmlSeen = 0;
    plugin.vite = {
        enforce: 'pre',
        configResolved(config) {
            isViteBuild = config.command === 'build';
        },
        transformIndexHtml: {
            // Run before Vite adds its own tags, so ours is the first of the <head>.
            order: 'pre',
            handler(html) {
                const result = injectEarlyCollectionTag(html);
                if (!result) {
                    return html;
                }
                viteHtmlSeen++;
                return result.html;
            },
        },
        closeBundle() {
            if (isViteBuild && viteHtmlSeen === 0) {
                warnNoHtml();
            }
        },
    };

    plugin.rollup = {
        generateBundle: {
            order: 'post',
            handler(_options, bundle) {
                const tally: Tally = { seen: 0, injected: 0 };
                for (const file of Object.values(bundle)) {
                    if (file.type !== 'asset' || !isHtmlFile(file.fileName)) {
                        continue;
                    }
                    const result = injectEarlyCollectionTag(toText(file.source));
                    record(tally, result);
                    if (result?.injected) {
                        file.source = result.html;
                    }
                }
                if (!tally.seen) {
                    warnNoHtml();
                }
            },
        },
    };

    // webpack and rspack share the same plugin API for what we need.
    const xpackPlugin: PluginOptions['webpack'] & PluginOptions['rspack'] = (compiler: any) => {
        const { Compilation, sources } = bundler;
        // "thisCompilation" is not called for child compilations,
        // so we don't process the HTML of sub-builds twice.
        compiler.hooks.thisCompilation.tap(EARLY_COLLECTION_PLUGIN_NAME, (compilation: any) => {
            compilation.hooks.processAssets.tap(
                {
                    name: EARLY_COLLECTION_PLUGIN_NAME,
                    // html-webpack-plugin and HtmlRspackPlugin emit at OPTIMIZE_INLINE.
                    stage: Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE,
                },
                () => {
                    const tally: Tally = { seen: 0, injected: 0 };
                    for (const asset of compilation.getAssets() as Array<{ name: string }>) {
                        if (!isHtmlFile(asset.name)) {
                            continue;
                        }
                        compilation.updateAsset(asset.name, (old: any) => {
                            const result = injectEarlyCollectionTag(toText(old.source()));
                            record(tally, result);
                            return result?.injected ? new sources.RawSource(result.html) : old;
                        });
                    }
                    if (!tally.seen) {
                        warnNoHtml();
                    }
                },
            );
        });
    };
    plugin.webpack = xpackPlugin;
    plugin.rspack = xpackPlugin;

    plugin.esbuild = {
        setup(build) {
            const { initialOptions } = build;
            build.onEnd(async () => {
                if (initialOptions.write === false) {
                    log.debug(
                        'Nothing is written to disk, skipping the early collection injection.',
                    );
                    return;
                }
                const outputDir =
                    initialOptions.outdir ??
                    (initialOptions.outfile ? path.dirname(initialOptions.outfile) : undefined);
                if (!outputDir) {
                    warnNoHtml();
                    return;
                }

                const tally: Tally = { seen: 0, injected: 0 };
                const files = await findHtmlFiles(getAbsolutePath(context.buildRoot, outputDir));
                await Promise.all(
                    files.map(async (file) => {
                        const result = injectEarlyCollectionTag(await fsp.readFile(file, 'utf-8'));
                        record(tally, result);
                        if (result?.injected) {
                            await fsp.writeFile(file, result.html);
                        }
                    }),
                );
                if (!tally.seen) {
                    warnNoHtml();
                }
            });
        },
    };

    return plugin;
};
