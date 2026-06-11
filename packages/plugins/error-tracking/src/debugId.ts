// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createHash, randomUUID } from 'crypto';

export const SUPPORTED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
export const DD_DEBUG_IDS = 'DD_DEBUG_IDS' as const;

const VARIANT_CHARS = ['8', '9', 'a', 'b'] as const;

export const getDebugIdSnippet = (codeOrHash?: string): string => {
    const debugId = codeOrHash ? stringToUUID(codeOrHash) : randomUUID();
    return `(function(c,n){try{if(typeof window==='undefined')return;var w=window,m=w[n]=w[n]||{},s=new Error().stack;s&&(m[s]=c)}catch(e){}})(${JSON.stringify(debugId)},${JSON.stringify(DD_DEBUG_IDS)});`;
};

// SHA-256(input) truncated to 128 bits → deterministic UUID-v4-shaped identifier.
// SHA-256 is used instead of MD5 for FIPS 140-2/3 compliance.
export const stringToUUID = (input: string): string => {
    const hash = createHash('sha256').update(input).digest('hex').slice(0, 32);
    const withVersion = `${hash.slice(0, 12)}4${hash.slice(13)}`;
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

// The snippet ends with (debugId, DD_DEBUG_IDS) — capture the UUID before the known marker.
const DEBUG_ID_RX = new RegExp(`"([^"]+)",${JSON.stringify(DD_DEBUG_IDS)}`);

export const getDebugIdFromSource = (source: string): string | undefined => {
    const match = source.match(DEBUG_ID_RX);
    return match ? match[1] : undefined;
};
