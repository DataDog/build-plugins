// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { InstrumentationOptions } from '@datadog/js-instrumentation-wasm';
import { LIVE_DEBUGGER_PROBES_FUNCTION } from '@dd/core/constants';

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
            // Live Debugger function IDs are not application strings. Moving
            // them into the module's dictionary would also make every
            // instrumented function read it, which throws when the function
            // is called before its module is evaluated (circular imports).
            excludeCallArguments: [LIVE_DEBUGGER_PROBES_FUNCTION],
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
