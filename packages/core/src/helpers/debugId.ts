// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { resolveEnable } from '@dd/core/helpers/options';
import type { ChunkInfo, Logger, Options } from '@dd/core/types';
import { createHash } from 'crypto';

const VARIANT_CHARS = ['8', '9', 'a', 'b'] as const;

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

// The debug ID of an output chunk. The RUM source code context snippet embeds it in the chunk
// and the sourcemap uploader reads it back to key the chunk's sourcemap. Any plugin exposing a
// chunk's debug ID must use this function so that all the values stay identical.
export const getChunkDebugId = (chunk: ChunkInfo): string => {
    return stringToUUID(chunk.sourceOrHash);
};

// Whether output chunks get a debug ID. The RUM plugin injects them when
// `rum.sourceCodeContext.debugId` is enabled, which the options validation also turns on for
// `sourcemaps.debugId`, so this expects the validated options given to plugins.
export const areDebugIdsEnabled = (options: Options, log: Logger): boolean => {
    return options.rum?.sourceCodeContext?.debugId === true && resolveEnable(options, 'rum', log);
};
