// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, Logger, PluginOptions } from '@dd/core/types';
import path from 'path';

import { PLUGIN_NAME, SUPPORTED_EXTENSIONS } from './constants';
import { getSnippet, stringToUUID } from './utils';

export const getDebugIdXpackPlugin =
    (
        bundler: any,
        log: Logger,
        context: GlobalContext,
        debugIds: Map<string, string>,
    ): PluginOptions['webpack'] & PluginOptions['rspack'] =>
    (compiler) => {
        const ConcatSource = bundler.sources.ConcatSource;

        compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation) => {
            const stage = bundler.Compilation.PROCESS_ASSETS_STAGE_ADDITIONS;

            compilation.hooks.processAssets.tap({ name: PLUGIN_NAME, stage }, () => {
                for (const chunk of compilation.chunks) {
                    const contentHash = chunk.contentHash?.javascript;
                    if (!contentHash) {
                        log.warn('Chunk has no javascript contentHash — debug_id skipped.');
                        continue;
                    }
                    const uuid = stringToUUID(contentHash);

                    for (const file of chunk.files) {
                        if (!SUPPORTED_EXTENSIONS.has(path.extname(file))) {
                            continue;
                        }
                        const absolutePath = path.resolve(context.bundler.outDir, file);
                        debugIds.set(absolutePath, uuid);

                        const snippet = getSnippet(uuid);
                        compilation.updateAsset(file, (old) => {
                            return new ConcatSource(snippet, '\n', old);
                        });
                    }
                }
            });
        });
    };
