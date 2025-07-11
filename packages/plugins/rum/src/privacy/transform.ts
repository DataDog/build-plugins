// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { InstrumentationOptions } from '@datadog/js-instrumentation-wasm';

import type { PrivacyOptions } from './types';

export interface TransformOutput {
    code: string;
    map?: string;
}

export function buildTransformOptions(pluginOptions: PrivacyOptions): InstrumentationOptions {
    return {
        input: {
            module: pluginOptions.module,
            jsx: pluginOptions.jsx,
            typescript: pluginOptions.typescript,
        },
        privacy: {
            addToDictionaryHelper: {
                import: {
                    cjsModule: `${pluginOptions.helpersModule}.cjs`,
                    esmModule: `${pluginOptions.helpersModule}.mjs`,
                    func: pluginOptions.addToDictionaryFunctionName ?? '$',
                },
            },
        },
    };
}
