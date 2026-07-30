// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { ChunkInfo } from '@dd/core/types';
import { randomUUID } from 'crypto';

import { stringToUUID } from './debugId';
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

type SourceCodeContext = {
    service?: string;
    version?: string;
    ddDebugId?: string;
};

export type SourceCodeContextSnippet = {
    code: string;
    debugId?: string;
};

export const getSourceCodeContextSnippet = (
    contextOptions: SourceCodeContextOptions,
    chunk?: ChunkInfo,
): SourceCodeContextSnippet => {
    const context: SourceCodeContext = {
        service: contextOptions.service,
        version: contextOptions.version,
    };

    if (contextOptions.debugId) {
        // Compute deterministic debug IDs whenever possible preventing the backend from storing duplicate source maps for identical build
        //
        // The `dd` prefix in `ddDebugId` allows upload tools (for example, datadog-ci) to reliably locate the
        // debug ID with a regex and send it as upload metadata alongside the source map.
        context.ddDebugId = chunk ? stringToUUID(chunk.sourceOrHash) : randomUUID();
    }

    const code = `(function(c,n){try{if(typeof window==='undefined')return;var w=window,m=w[n]=w[n]||{},s=new Error().stack;s&&(m[s]=c)}catch(e){}})(${JSON.stringify(context)},${JSON.stringify(DEFAULT_SOURCE_CODE_CONTEXT_VARIABLE)});`;

    return { code, debugId: context.ddDebugId };
};
