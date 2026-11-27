// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { instrument } from '@datadog/js-instrumentation-wasm';
import type { InstrumentationOptions } from '@datadog/js-instrumentation-wasm';
import {
    TransformWorkerPool,
    getTransformWorkerCount,
    resolveWorkerScript,
} from '@dd/core/helpers/workerPool';
import type { GlobalContext, PluginOptions } from '@dd/core/types';
import type { NativeBuildContext } from 'unplugin';

import { PLUGIN_NAME } from './constants';
import { buildTransformOptions } from './transform';
import type { PrivacyOptionsWithDefaults } from './types';
import type { RumPrivacyWorkerResult, RumPrivacyWorkerTask } from './worker';

const WORKER_FILENAME = 'rum-privacy-worker.js';

function getRawInputSourceMap(
    nativeBuildContext: NativeBuildContext | undefined,
): string | object | undefined {
    // Only rspack and webpack expose the input source map. Beyond that, we wouldn't want
    // to process it on other bundlers, because they automatically merge the source maps
    // produced by chained loaders.
    if (nativeBuildContext?.framework !== 'rspack' && nativeBuildContext?.framework !== 'webpack') {
        return undefined;
    }

    const raw = nativeBuildContext.inputSourceMap;
    return raw === undefined || raw === null ? undefined : (raw as string | object);
}

function serializeInputSourceMap(map: string | object | undefined): string | undefined {
    if (map === undefined) {
        return undefined;
    }
    return typeof map === 'string' ? map : JSON.stringify(map);
}

export const getPrivacyPlugin = (
    pluginOptions: PrivacyOptionsWithDefaults,
    context: GlobalContext,
): PluginOptions => {
    const log = context.getLogger(PLUGIN_NAME);

    const transformOptions = buildTransformOptions(
        pluginOptions.helperCodeExpression,
        context.bundler.name,
    );
    let dictionaryEntryCount = 0;
    let fileCount = 0;

    const workerCount = getTransformWorkerCount();
    const resolvedWorker =
        workerCount > 0 ? resolveWorkerScript(__dirname, WORKER_FILENAME, __filename) : undefined;
    const workerPool = resolvedWorker
        ? new TransformWorkerPool<
              InstrumentationOptions,
              RumPrivacyWorkerTask,
              RumPrivacyWorkerResult
          >({
              workerScriptPath: resolvedWorker.workerScriptPath,
              pnpPath: resolvedWorker.pnpPath,
              issuerPath: __filename,
              initData: transformOptions,
              size: workerCount,
          })
        : undefined;

    return {
        name: PLUGIN_NAME,
        // Enforce when the plugin will be executed.
        // Not supported by Rollup and ESBuild.
        // https://vitejs.dev/guide/api-plugin.html#plugin-ordering
        enforce: 'post',
        transform: {
            filter: {
                id: {
                    include: pluginOptions.include,
                    exclude: pluginOptions.exclude,
                },
            },
            handler(code, id) {
                const rawMap = getRawInputSourceMap(this.getNativeBuildContext?.());

                if (workerPool) {
                    return workerPool
                        .run({ id, code, map: rawMap })
                        .then((result) => {
                            if (result.unchanged) {
                                return { code };
                            }
                            dictionaryEntryCount += result.privacyDictionarySize;
                            fileCount++;
                            return {
                                code: result.code,
                                map: result.map,
                            };
                        })
                        .catch((e) => {
                            log.error(`Instrumentation Error: ${e}`, { forward: true });
                            return { code };
                        });
                }

                try {
                    const map = serializeInputSourceMap(rawMap);
                    const result = instrument({ id, code, map }, transformOptions);
                    if (result.privacyDictionarySize === 0) {
                        return {
                            // This should be the same as the result from js-instrumentation-wasm
                            // returning the original code only to make it explicit for debugging purposes
                            code,
                        };
                    }
                    dictionaryEntryCount += result.privacyDictionarySize;
                    fileCount++;
                    return result;
                } catch (e) {
                    log.error(`Instrumentation Error: ${e}`, { forward: true });
                    return {
                        code,
                    };
                }
            },
        },
        buildEnd: async () => {
            if (workerPool) {
                await workerPool.terminateAll();
            }
            log.debug(
                `Privacy dictionary will include ${dictionaryEntryCount} entries across ${fileCount} files`,
                {
                    forward: true,
                    context: {
                        dictionaryEntryCount,
                        fileCount,
                    },
                },
            );
        },
    };
};
