// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { SourceCodeContextOptions } from './types';

export const DEFAULT_SOURCE_CODE_CONTEXT_VARIABLE = 'DD_SOURCE_CODE_CONTEXT' as const;

// The source code context snippet - single injection with function definition and call
// SSR-safe: checks window before accessing, never throws
//
// Unminified version:
// (function(c, n) {
//     try {
//         if (typeof window === 'undefined') return;
//         var w = window,
//             m = w[n] = w[n] || {},
//             s = new Error().stack;
//         s && (m[s] = c)
//     } catch (e) {}
// })(context, variableName);
export const getSourceCodeContextSnippet = (context: SourceCodeContextOptions): string => {
    return `(function(c,n){try{if(typeof window==='undefined')return;var w=window,m=w[n]=w[n]||{},s=new Error().stack;s&&(m[s]=c)}catch(e){}})(${JSON.stringify(context)},${JSON.stringify(DEFAULT_SOURCE_CODE_CONTEXT_VARIABLE)});`;
};
