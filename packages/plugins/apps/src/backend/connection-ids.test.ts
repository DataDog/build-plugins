// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { mergeAllowedConnectionIds } from './connection-ids';

describe('mergeAllowedConnectionIds', () => {
    test('merges, deduplicates, and sorts connection IDs', () => {
        const configured = [
            '22222222-2222-2222-2222-222222222222',
            '11111111-1111-1111-1111-111111111111',
        ];
        const discovered = [
            '33333333-3333-3333-3333-333333333333',
            '22222222-2222-2222-2222-222222222222',
        ];

        expect(mergeAllowedConnectionIds(configured, discovered)).toEqual([
            '11111111-1111-1111-1111-111111111111',
            '22222222-2222-2222-2222-222222222222',
            '33333333-3333-3333-3333-333333333333',
        ]);
    });

    test('handles empty arrays', () => {
        expect(mergeAllowedConnectionIds([], [])).toEqual([]);
        expect(mergeAllowedConnectionIds(['a'], [])).toEqual(['a']);
        expect(mergeAllowedConnectionIds([], ['b'])).toEqual(['b']);
    });
});
