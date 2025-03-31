// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { isXpack } from '@dd/core/helpers/bundlers';
import { isInjectionFile } from '@dd/core/helpers/plugins';
import { getUniqueId } from '@dd/core/helpers/strings';
import {
    InjectPosition,
    type GetInternalPlugins,
    type GetInternalPluginsArg,
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

export const getInjectionPlugins: GetInternalPlugins = (arg: GetInternalPluginsArg) => {
    const { bundler, context } = arg;
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

    const plugin: PluginOptions = {
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
    };

    // We need to handle the resolution in xpack,
    // and it's easier to use unplugin's hooks for it.
    if (isXpack(context.bundler.fullName)) {
        plugin.loadInclude = (id) => {
            if (isInjectionFile(id)) {
                return true;
            }

            return null;
        };

        plugin.load = (id) => {
            if (isInjectionFile(id)) {
                return {
                    code: getContentToInject(contentsToInject[InjectPosition.MIDDLE]),
                };
            }
            return null;
        };
    } else {
        // In xpack, we need to prepare the injections BEFORE the build starts.
        // Otherwise, the bundler doesn't have the content when it needs it.
        // So we do it in their specific plugin.
        // Here for all the other non-xpack bundlers.
        plugin.buildStart = async () => {
            // Prepare the injections.
            await addInjections(log, injections, contentsToInject, context.cwd);
        };
    }

    return [plugin];
};
