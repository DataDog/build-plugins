// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { INJECTED_FILE } from '@dd/core/constants';
import { getUniqueId, rm } from '@dd/core/helpers';
import {
    InjectPosition,
    type GlobalContext,
    type Logger,
    type Options,
    type PluginOptions,
    type ToInjectItem,
} from '@dd/core/types';
import path from 'path';

import { PLUGIN_NAME, CLEANING_PLUGIN_NAME } from './constants';
import { getEsbuildPlugin } from './esbuild';
import { getRollupPlugin } from './rollup';
import type { ContentsToInject, FilesToInject } from './types';
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

    // Create unique filenames to avoid conflicts.
    const positionsToInject = [InjectPosition.BEFORE, InjectPosition.MIDDLE, InjectPosition.AFTER];
    const fileNames = Object.fromEntries<string>(
        positionsToInject.map((position) => [
            position,
            `${getUniqueId()}.${position}.${INJECTED_FILE}.js`,
        ]),
    ) as Record<InjectPosition, string>;

    // This can't be static as it uses context.bundler.outDir that gets updated in buildStart.
    const getFilesToInject = (): FilesToInject => {
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
        ) as FilesToInject;
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
        // Inject the file that will be home of all injected content.
        // Each bundler has its own way to inject a file.
        {
            name: PLUGIN_NAME,
            enforce: 'post',
            esbuild: getEsbuildPlugin(log, context, toInject, contentsToInject, getFilesToInject),
            webpack: getXpackPlugin(
                bundler,
                log,
                context,
                toInject,
                getFilesToInject,
                contentsToInject,
            ),
            rspack: getXpackPlugin(
                bundler,
                log,
                context,
                toInject,
                getFilesToInject,
                contentsToInject,
            ),
            rollup: getRollupPlugin(log, toInject, contentsToInject),
            vite: { ...getRollupPlugin(log, toInject, contentsToInject), enforce: 'pre' },
        },
        {
            name: CLEANING_PLUGIN_NAME,
            enforce: 'post',
            async buildEnd() {
                if (options.devServer) {
                    // TODO: Find a way to clean the file in devServer mode.
                    return;
                }

                const filesToInject = getFilesToInject();
                const proms = [];

                for (const file of Object.values(filesToInject)) {
                    // Remove our assets.
                    proms.push(rm(file.absolutePath));
                }

                await Promise.all(proms);
            },
        },
    ];

    return plugins;
};
