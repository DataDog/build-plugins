// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { InjectPosition, type PluginOptions } from '@dd/core/types';

import type { FilesToInject } from './types';

export const getEsbuildPlugin = (
    getFilesToInject: () => FilesToInject,
): PluginOptions['esbuild'] => ({
    setup(build) {
        const { initialOptions } = build;

        const filesToInject = getFilesToInject();

        // Inject the file in the build.
        // NOTE: This is made "safer" for sub-builds by actually creating the file.
        initialOptions.inject = initialOptions.inject || [];
        initialOptions.inject.push(filesToInject[InjectPosition.BEFORE].absolutePath);
    },
});
