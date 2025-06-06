// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { InstrumentationOptions } from '@datadog/js-instrumentation-wasm';

import { PRIVACY_HELPERS_MODULE_ID } from './constants';
import type { PluginOptions } from './options';

export interface TransformOutput {
    code: string;
    map?: string;
}

export function buildTransformOptions(pluginOptions: PluginOptions): InstrumentationOptions {
    return {
        input: {
            module: pluginOptions.module,
            jsx: pluginOptions.jsx,
            typescript: pluginOptions.typescript,
        },
        privacy: {
            addToDictionaryHelper: {
                import: {
                    module: PRIVACY_HELPERS_MODULE_ID,
                    func: '$',
                },
            },
        },
    };
}
