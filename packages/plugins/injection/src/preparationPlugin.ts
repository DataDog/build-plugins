// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, readFileSafeSync, rm } from '@dd/core/helpers';
import type { GlobalContext, Logger, Options, PluginOptions, ToInjectItem } from '@dd/core/types';

import { PREPARATION_PLUGIN_NAME } from './constants';
import { getContentToInject, needsFile, processInjections } from './helpers';
import type { ContentsToInject, FilesToInject } from './types';

export const getPreparationPlugin = (
    options: Options,
    context: GlobalContext,
    log: Logger,
    toInject: Map<string, ToInjectItem>,
    getFilesToInject: () => FilesToInject,
    contentsToInject: ContentsToInject,
): PluginOptions => {
    // Prepare and fetch the content to inject for all bundlers.
    return {
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
    };
};
