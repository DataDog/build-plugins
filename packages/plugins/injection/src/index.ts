// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getUniqueId, isInjectionFile } from '@dd/core/helpers';
import {
    InjectPosition,
    type GlobalContext,
    type PluginOptions,
    type ToInjectItem,
} from '@dd/core/types';

import { PLUGIN_NAME } from './constants';
import { getEsbuildPlugin } from './esbuild';
import { addInjections, getContentToInject } from './helpers';
import { getRollupPlugin } from './rollup';
import type { ContentsToInject } from './types';
import { getXpackPlugin } from './xpack';

export { PLUGIN_NAME } from './constants';

export const getInjectionPlugins = (bundler: any, context: GlobalContext): PluginOptions[] => {
    const log = context.getLogger(PLUGIN_NAME);
    // Storage for all the injections.
    const injections: Map<string, ToInjectItem> = new Map();

    // Storage for all the positional contents we want to inject.
    const contentsToInject: ContentsToInject = {
        [InjectPosition.BEFORE]: new Map(),
        [InjectPosition.MIDDLE]: new Map(),
        [InjectPosition.AFTER]: new Map(),
    };

    context.inject = (item: ToInjectItem) => {
        injections.set(getUniqueId(), item);
    };

    const plugins: PluginOptions[] = [
        {
            name: PLUGIN_NAME,
            enforce: 'post',
            // Bundler specific part of the plugin.
            // We use it to:
            // - Inject the content in the right places, each bundler offers this differently.
            esbuild: getEsbuildPlugin(log, context, contentsToInject),
            webpack: getXpackPlugin(bundler, log, context, injections, contentsToInject),
            rspack: getXpackPlugin(bundler, log, context, injections, contentsToInject),
            rollup: getRollupPlugin(contentsToInject),
            vite: { ...getRollupPlugin(contentsToInject), enforce: 'pre' },
            // Universal part of the plugin.
            // We use it to:
            // - Prepare the injections.
            // - Handle the resolution of the injection file.
            async buildStart() {
                // In xpack, we need to prepare the injections before the build starts.
                // So we do it in their specific plugin.
                if (['webpack', 'rspack'].includes(context.bundler.name)) {
                    return;
                }

                // Prepare the injections.
                await addInjections(log, injections, contentsToInject, context.cwd);
            },
            async resolveId(source) {
                if (isInjectionFile(source)) {
                    return { id: source };
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
                    };
                }
                return null;
            },
        },
    ];

    return plugins;
};
