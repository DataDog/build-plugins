// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Deterministic randomness, so a run ID always reproduces the same build order,
// load order and bootstrap samples.

export const hash = (value: string): number => {
    let result = 0;
    for (const character of value) {
        result = (result * 31 + character.charCodeAt(0)) % Number.MAX_SAFE_INTEGER;
    }
    return result;
};

export type Random = () => number;

// Park and Miller's minimal standard generator: plain arithmetic that stays exact
// in doubles. Plenty for shuffling and bootstrap resampling.
const MODULUS = 2_147_483_647;
const MULTIPLIER = 48_271;

export const createRandom = (seed: string): Random => {
    let state = (hash(seed) % (MODULUS - 1)) + 1;
    const next = (): number => {
        state = (state * MULTIPLIER) % MODULUS;
        return (state - 1) / (MODULUS - 1);
    };
    // The first draw follows the seed's hash too closely.
    next();
    return next;
};

// Fisher-Yates shuffle into a new array.
export const shuffle = <T>(values: readonly T[], random: Random): T[] => {
    const shuffled = [...values];
    for (let index = shuffled.length - 1; index > 0; index--) {
        const position = random() * (index + 1);
        const swapIndex = Math.floor(position);
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
};
