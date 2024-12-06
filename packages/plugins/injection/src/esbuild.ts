// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger, ToInjectItem, PluginOptions } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';

import { addInjections, createFiles } from './helpers';
import type { ContentsToInject, FilesToInject } from './types';

export const getEsbuildPlugin = (
    log: Logger,
    toInject: Map<string, ToInjectItem>,
    contentsToInject: ContentsToInject,
    getFilesToInject: () => FilesToInject,
): PluginOptions['esbuild'] => ({
    setup(build) {
        const { onStart, initialOptions } = build;

        onStart(async () => {
            // Prepare the injections.
            await addInjections(log, toInject, contentsToInject);

            try {
                // Actually create the files to avoid any resolution errors.
                await createFiles(log, getFilesToInject);
            } catch (e: any) {
                log.error(`Could not create the files: ${e.message}`);
            }
        });

        const filesToInject = getFilesToInject();

        // Inject the file in the build.
        // NOTE: This is made "safer" for sub-builds by actually creating the file.
        initialOptions.inject = initialOptions.inject || [];
        initialOptions.inject.push(filesToInject[InjectPosition.BEFORE].absolutePath);
    },
});
