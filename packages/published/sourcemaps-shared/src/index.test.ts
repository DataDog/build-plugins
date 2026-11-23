// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getCheckExistsBatches } from './index';

const EXPECTED_API_BATCH_LIMIT = 1000;

describe('getCheckExistsBatches', () => {
    test('deduplicates IDs without reordering them', () => {
        const batches = [...getCheckExistsBatches(['b', 'a', 'b'])];

        expect(batches).toEqual([['b', 'a']]);
    });

    test('returns one batch for exactly 1000 IDs', () => {
        const ids = Array.from({ length: EXPECTED_API_BATCH_LIMIT }, (_, index) => `id-${index}`);
        const batches = [...getCheckExistsBatches(ids)];

        expect(batches).toEqual([ids]);
    });

    test('splits 1001 IDs into batches of 1000 and 1', () => {
        const ids = Array.from(
            { length: EXPECTED_API_BATCH_LIMIT + 1 },
            (_, index) => `id-${index}`,
        );
        const batches = [...getCheckExistsBatches(ids)];
        const firstBatch = ids.slice(0, EXPECTED_API_BATCH_LIMIT);
        const secondBatch = ids.slice(EXPECTED_API_BATCH_LIMIT);

        expect(batches).toEqual([firstBatch, secondBatch]);
    });

    test('returns no batches for empty input', () => {
        const batches = [...getCheckExistsBatches([])];

        expect(batches).toEqual([]);
    });
});
