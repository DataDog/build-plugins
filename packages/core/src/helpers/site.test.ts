// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parseSite } from '@dd/core/helpers/site';

describe('Core Helpers', () => {
    describe('parseSite', () => {
        const cases = [
            {
                description: 'accept a bare known site unchanged',
                input: 'us5.datadoghq.com',
                expected: { site: 'us5.datadoghq.com' },
            },
            {
                description: 'accept a custom subdomain on top of a known site',
                input: 'customsubdomain.us5.datadoghq.com',
                expected: { site: 'us5.datadoghq.com', subdomain: 'customsubdomain' },
            },
            {
                description: 'accept a custom subdomain on top of a bare site',
                input: 'foobar.datadoghq.com',
                expected: { site: 'datadoghq.com', subdomain: 'foobar' },
            },
            {
                description: 'prefer the longest (most specific) matching base site',
                input: 'myorg.us5.datadoghq.com',
                expected: { site: 'us5.datadoghq.com', subdomain: 'myorg' },
            },
            {
                description: 'match case-insensitively and normalize to lowercase',
                input: 'CustomSubdomain.US5.DatadogHQ.com',
                expected: { site: 'us5.datadoghq.com', subdomain: 'customsubdomain' },
            },
            {
                description: 'reject a site that is not a known site or subdomain of one',
                input: 'not-a-real-site.example.com',
                expected: undefined,
            },
            {
                description: 'reject a subdomain with multiple labels',
                input: 'foo.bar.datadoghq.com',
                expected: undefined,
            },
            {
                description: 'reject a subdomain with invalid characters',
                input: 'foo_bar.datadoghq.com',
                expected: undefined,
            },
            {
                description: 'reject a non-string value instead of throwing',
                input: 123 as unknown as string,
                expected: undefined,
            },
            {
                description: 'reject a null value instead of throwing',
                input: null as unknown as string,
                expected: undefined,
            },
        ];

        test.each(cases)('should $description', ({ input, expected }) => {
            expect(parseSite(input)).toEqual(expected);
        });
    });
});
