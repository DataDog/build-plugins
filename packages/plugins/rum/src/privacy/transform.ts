// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { InstrumentationOptions } from '@datadog/js-instrumentation-wasm';

export interface TransformOutput {
    code: string;
    map?: string;
}

export function buildTransformOptions(helperCodeExpression?: string): InstrumentationOptions {
    return {
        privacy: {
            addToDictionaryHelper: {
                expression: {
                    code:
                        helperCodeExpression ??
                        `/*__PURE__*/((q='$DD_A_Q',g=globalThis)=>(g[q]=g[q]||[],(v=>(g[q].push(v),v))))()`,
                },
            },
        },
    };
}
