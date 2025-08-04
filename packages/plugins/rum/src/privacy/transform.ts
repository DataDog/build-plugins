// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { InstrumentationOptions } from '@datadog/js-instrumentation-wasm';

export interface TransformOutput {
    code: string;
    map?: string;
}

export function buildTransformOptions(
    helperCodeExpression: string,
    bundlerName: string,
): InstrumentationOptions {
    const transformOptions: InstrumentationOptions = {
        privacy: {
            addToDictionaryHelper: {
                expression: {
                    code: helperCodeExpression,
                },
            },
        },
    };
    if (['esbuild', 'webpack', 'rspack'].includes(bundlerName)) {
        transformOptions.output = {
            ...transformOptions.output,
            inlineSourceMap: false,
            embedCodeInSourceMap: true,
        };
    }
    return transformOptions;
}
