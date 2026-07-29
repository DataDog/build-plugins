// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import xxhash from 'xxhash-wasm';
import type { XXHashAPI } from 'xxhash-wasm';

const VARIANT_CHARS = ['8', '9', 'a', 'b'] as const;
// Arbitrary fixed seed so the second half is independent from the first (which uses the default seed).
const SECOND_HALF_SEED = BigInt('0x9e3779b97f4a7c15');

let hasher: XXHashAPI | undefined;
let hasherInitPromise: Promise<XXHashAPI> | undefined;

// Must be awaited (e.g. during a build's `buildStart`) before any synchronous `stringToUUID` call.
export const initDebugIdHasher = async (): Promise<void> => {
    if (hasher) {
        return;
    }

    hasherInitPromise =
        hasherInitPromise ??
        xxhash().then((api) => {
            hasher = api;
            return api;
        });

    await hasherInitPromise;
};

// xxHash64(input) || xxHash64(input, seed) → 128 bits, reshaped into a deterministic UUID-v4-shaped identifier.
// xxHash instead of a cryptographic hash: debug IDs only need to be deterministic and cheap to compute.
export const stringToUUID = (input: string): string => {
    if (!hasher) {
        throw new Error('[stringToUUID] Hasher not initialized: call `initDebugIdHasher()` first.');
    }
    // xxhash-wasm only implements 32/64-bit XXH, not the 128-bit XXH3, so we derive 128 bits
    // by re-seeding and concatenating two independent 64-bit hashes of the same input.
    const firstHalf = hasher.h64(input).toString(16).padStart(16, '0');
    const secondHalf = hasher.h64(input, SECOND_HALF_SEED).toString(16).padStart(16, '0');
    const hash = `${firstHalf}${secondHalf}`;
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
