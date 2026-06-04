// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createHash } from 'crypto';

const VARIANT_CHARS = ['8', '9', 'a', 'b'] as const;

// MD5(input) → deterministic UUID-v4-shaped identifier.
export const stringToUUID = (input: string): string => {
    const md5 = createHash('md5').update(input).digest('hex');
    const withVersion = `${md5.slice(0, 12)}4${md5.slice(13)}`;
    const variantIndex = withVersion.charCodeAt(16) % 4;
    const withVariant = `${withVersion.slice(0, 16)}${VARIANT_CHARS[variantIndex]}${withVersion.slice(17)}`;
    return [
        withVariant.slice(0, 8),
        withVariant.slice(8, 12),
        withVariant.slice(12, 16),
        withVariant.slice(16, 20),
        withVariant.slice(20, 32),
    ].join('-');
};

export const DD_DEBUG_IDS_VARIABLE = 'DD_DEBUG_IDS' as const;

// Runtime snippet, prepended to each emitted JS file. It registers the debug_id
// keyed by the script's own `new Error().stack`, so the SDK can collect it at
// runtime and the upload step can recover it by parsing the snippet.
// SSR-safe: checks window before accessing, never throws.
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
// })(debugId, variableName);
export const getSnippet = (uuid: string): string => {
    return `(function(c,n){try{if(typeof window==='undefined')return;var w=window,m=w[n]=w[n]||{},s=new Error().stack;s&&(m[s]=c)}catch(e){}})(${JSON.stringify(uuid)},${JSON.stringify(DD_DEBUG_IDS_VARIABLE)});`;
};

// Recovers the debug_id from a snippet-injected source.
const DEBUG_ID_RX = /([0-9a-f-]{36})["'],["']DD_DEBUG_IDS/;

export const getDebugIdFromSource = (source: string): string | undefined => {
    const match = source.match(DEBUG_ID_RX);
    return match ? match[1] : undefined;
};
