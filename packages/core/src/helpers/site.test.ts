// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parseSite } from '@dd/core/helpers/site';

import siteVectors from './site.fixtures.json';

describe('Core Helpers', () => {
    describe('parseSite', () => {
        const vectorCases = Object.entries(siteVectors).map(([input, expected]) => ({
            description: JSON.stringify(input),
            input,
            expected: expected === 'rejected' ? undefined : expected,
        }));

        test.each(vectorCases)(
            'should parse $description like the Datadog apps CLI',
            ({ input, expected }) => {
                expect(parseSite(input)).toEqual(expected);
            },
        );

        const nonStringCases = [
            { description: 'a number', input: 123 },
            { description: 'null', input: null },
            { description: 'undefined', input: undefined },
            { description: 'an object', input: { site: 'datadoghq.com' } },
        ];

        test.each(nonStringCases)('should reject $description instead of throwing', ({ input }) => {
            expect(parseSite(input)).toBeUndefined();
        });
    });
});
