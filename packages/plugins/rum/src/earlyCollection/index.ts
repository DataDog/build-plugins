// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, readFile } from '@dd/core/helpers/fs';
import { getAbsolutePath } from '@dd/core/helpers/paths';
import type { GlobalContext, PluginOptions } from '@dd/core/types';
import fs from 'fs';
import path from 'path';

import { EARLY_COLLECTION_PLUGIN_NAME, PLUGIN_NAME } from '../constants';

import {
    EARLY_COLLECTION_URL,
    getNoHtmlWarning,
    hasEarlyCollectionTag,
    injectEarlyCollectionTag,
    isHtmlFile,
} from './html';

const fsp = fs.promises;

const toText = (source: string | Uint8Array): string =>
    typeof source === 'string' ? source : Buffer.from(source).toString('utf-8');

// Whether "child" is "parent" or lives inside it.
const isInside = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
};

const findHtmlFiles = async (dir: string): Promise<string[]> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = await Promise.all(
        entries.map((entry) => {
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                // Skip the dependencies and the hidden folders (.git, .cache, ...).
                return entry.name === 'node_modules' || entry.name.startsWith('.')
                    ? []
                    : findHtmlFiles(entryPath);
            }
            // Regular files only, we don't follow symlinks out of the output directory.
            return entry.isFile() && isHtmlFile(entry.name) ? [entryPath] : [];
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
    // Only warn once per build tool instance, not on every rebuild or output.
    let warned = false;
    const warnNoHtml = (reason: string) => {
        if (warned) {
            return;
        }
        warned = true;
        log.warn(getNoHtmlWarning(reason, context.bundler.name));
    };
    const NO_HTML = 'no HTML file with a <head> was found in the build output';

    const plugin: PluginOptions = {
        name: EARLY_COLLECTION_PLUGIN_NAME,
    };

    let isViteBuild = false;
    let isViteAppBuild = true;
    let viteHtmlSeen = 0;
    plugin.vite = {
        enforce: 'pre',
        configResolved(config) {
            isViteBuild = config.command === 'build';
            // Library and SSR builds don't produce a page.
            isViteAppBuild = !config.build?.lib && !config.build?.ssr;
        },
        transformIndexHtml: {
            // Run before Vite adds its own tags, so ours is the first of the <head>.
            order: 'pre',
            handler(html) {
                viteHtmlSeen++;
                if (hasEarlyCollectionTag(html)) {
                    return [];
                }
                // Let Vite place the tag, it also handles pages without <head>.
                return [
                    {
                        tag: 'script',
                        attrs: { src: EARLY_COLLECTION_URL },
                        injectTo: 'head-prepend',
                    },
                ];
            },
        },
        closeBundle() {
            if (isViteBuild && isViteAppBuild && viteHtmlSeen === 0) {
                warnNoHtml(NO_HTML);
            }
        },
    };

    let rollupHtmlSeen = 0;
    plugin.rollup = {
        generateBundle: {
            order: 'post',
            handler(_options, bundle) {
                for (const file of Object.values(bundle)) {
                    if (file.type !== 'asset' || !isHtmlFile(file.fileName)) {
                        continue;
                    }
                    const result = injectEarlyCollectionTag(toText(file.source));
                    if (!result) {
                        continue;
                    }
                    rollupHtmlSeen++;
                    if (result.injected) {
                        file.source = result.html;
                    }
                }
                // Another output may still have HTML, so only warn when none had any so far.
                if (!rollupHtmlSeen) {
                    warnNoHtml(NO_HTML);
                }
            },
        },
    };

    // webpack and rspack share the same plugin API for what we need.
    const xpackPlugin: PluginOptions['webpack'] & PluginOptions['rspack'] = (compiler) => {
        const { Compilation, sources } = bundler;
        // "thisCompilation" is not called for child compilations,
        // so we don't process the HTML of sub-builds twice.
        compiler.hooks.thisCompilation.tap(EARLY_COLLECTION_PLUGIN_NAME, (compilation) => {
            compilation.hooks.processAssets.tap(
                {
                    name: EARLY_COLLECTION_PLUGIN_NAME,
                    // html-webpack-plugin and HtmlRspackPlugin emit at OPTIMIZE_INLINE.
                    stage: Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE,
                },
                () => {
                    let htmlSeen = 0;
                    for (const { name } of compilation.getAssets()) {
                        const asset = isHtmlFile(name) ? compilation.getAsset(name) : undefined;
                        if (!asset) {
                            continue;
                        }
                        const result = injectEarlyCollectionTag(toText(asset.source.source()));
                        if (!result) {
                            continue;
                        }
                        htmlSeen++;
                        // Don't touch the assets we don't change, so their hash stays the same.
                        if (result.injected) {
                            compilation.updateAsset(name, new sources.RawSource(result.html));
                        }
                    }
                    if (!htmlSeen) {
                        warnNoHtml(NO_HTML);
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
            build.onEnd(async (result) => {
                if (result.errors.length) {
                    return;
                }
                if (initialOptions.write === false) {
                    warnNoHtml('esbuild does not write the build output to disk (write: false)');
                    return;
                }
                const outputDir =
                    initialOptions.outdir ??
                    (initialOptions.outfile ? path.dirname(initialOptions.outfile) : undefined);
                if (!outputDir) {
                    warnNoHtml('the esbuild output directory could not be determined');
                    return;
                }

                const absoluteOutputDir = getAbsolutePath(context.buildRoot, outputDir);
                // We only want to rewrite the build output, never the sources of the project.
                if (isInside(absoluteOutputDir, context.buildRoot)) {
                    warnNoHtml(
                        'the esbuild output directory is the project root (or one of its parents), so the HTML files cannot be told apart from your sources',
                    );
                    return;
                }

                let htmlSeen = 0;
                const files = await findHtmlFiles(absoluteOutputDir);
                await Promise.all(
                    files.map(async (file) => {
                        const content = await readFile(file);
                        const injection = injectEarlyCollectionTag(content);
                        if (!injection) {
                            return;
                        }
                        htmlSeen++;
                        if (injection.injected) {
                            await outputFile(file, injection.html);
                        }
                    }),
                );
                if (!htmlSeen) {
                    warnNoHtml(NO_HTML);
                }
            });
        },
    };

    return plugin;
};
