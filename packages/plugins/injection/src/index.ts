// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { isInjectionFile } from '@dd/core/helpers';
import {
    InjectPosition,
    type GlobalContext,
    type Logger,
    type Options,
    type PluginOptions,
    type ToInjectItem,
} from '@dd/core/types';

import { PLUGIN_NAME, CLEANING_PLUGIN_NAME } from './constants';
import { getEsbuildPlugin } from './esbuild';
import { addInjections, getContentToInject } from './helpers';
import { getRollupPlugin } from './rollup';
import type { ContentsToInject } from './types';
import { getXpackPlugin } from './xpack';

export { PLUGIN_NAME } from './constants';

export const getInjectionPlugins = (
    bundler: any,
    options: Options,
    context: GlobalContext,
    toInject: Map<string, ToInjectItem>,
    log: Logger,
): PluginOptions[] => {
    // Storage for all the positional contents we want to inject.
    const contentsToInject: ContentsToInject = {
        [InjectPosition.BEFORE]: new Map(),
        [InjectPosition.MIDDLE]: new Map(),
        [InjectPosition.AFTER]: new Map(),
    };

    // This plugin happens in 2 steps in order to cover all bundlers:
    //   1. Prepare the content to inject, fetching distant/local files and anything necessary.
    //       a. [esbuild] We also create the actual file for esbuild to avoid any resolution errors
    //            and keep the inject override safe.
    //       b. [esbuild] With a custom resolver, every client side sub-builds would fail to resolve
    //            the file when re-using the same config as the parent build (with the inject).
    //   2. Inject content.
    //       a. Use each bundler's way to inject content.
    //       b. Globally clean the injected temporary files.
    const plugins: PluginOptions[] = [
        {
            name: PLUGIN_NAME,
            enforce: 'post',
            esbuild: getEsbuildPlugin(log, context, contentsToInject),
            webpack: getXpackPlugin(bundler, log, context, toInject, contentsToInject),
            rspack: getXpackPlugin(bundler, log, context, toInject, contentsToInject),
            rollup: getRollupPlugin(contentsToInject),
            vite: { ...getRollupPlugin(contentsToInject), enforce: 'pre' },
        },
        {
            name: CLEANING_PLUGIN_NAME,
            enforce: 'post',
            async buildStart() {
                // In webpack, we need to prepare the injections before the build starts.
                if (context.bundler.name === 'webpack') {
                    return;
                }
                // Prepare the injections.
                await addInjections(log, toInject, contentsToInject);
            },
            async resolveId(source) {
                if (isInjectionFile(source)) {
                    // It is important that side effects are always respected for injections, otherwise using
                    // "treeshake.moduleSideEffects: false" may prevent the injection from being included.
                    return { id: source, moduleSideEffects: true };
                }

                return null;
            },
            loadInclude(id) {
                if (isInjectionFile(id)) {
                    return true;
                }

                return null;
            },
            load(id) {
                if (isInjectionFile(id)) {
                    return {
                        code: getContentToInject(contentsToInject[InjectPosition.MIDDLE]),
                        moduleSideEffects: true,
                    };
                }
                return null;
            },
        },
    ];

    return plugins;
};
