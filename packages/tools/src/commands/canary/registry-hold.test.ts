// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import nock from 'nock';

import type { GetPublishedAt } from './registry-hold';
import {
    fetchNpmPublishedAt,
    findRefusedPackages,
    findRegistryHold,
    REGISTRY_HOLD_MS,
} from './registry-hold';

const MIRROR = 'https://depot-read-api-npm.us1.ddbuild.io/internal/magicmirror/magicmirror';

// Output each package manager printed against Datadog's npm mirror on 2026-11-26,
// for a version published the same day.
const refusedCases = [
    {
        description: 'find a version Yarn 4 found no candidates for',
        output: [
            '➤ YN0000: ┌ Resolution step',
            '➤ YN0082: │ @formatjs/bigdecimal@npm:0.2.12: No candidates found',
            '➤ YN0000: └ Completed in 0s 326ms',
        ].join('\n'),
        expected: [{ name: '@formatjs/bigdecimal', version: '0.2.12' }],
    },
    {
        description: 'find a version Yarn 6 found no candidates for',
        output: '➤ │ @formatjs/bigdecimal@npm:0.2.12: No candidates found for npm:0.2.12',
        expected: [{ name: '@formatjs/bigdecimal', version: '0.2.12' }],
    },
    {
        description: 'find a version Yarn 1 found no versions for',
        output: 'error Couldn\'t find any versions for "@formatjs/bigdecimal" that matches "0.2.12"',
        expected: [{ name: '@formatjs/bigdecimal', version: '0.2.12' }],
    },
    {
        description: 'find a version npm found no match for',
        output: 'npm error notarget No matching version found for @formatjs/bigdecimal@0.2.12.',
        expected: [{ name: '@formatjs/bigdecimal', version: '0.2.12' }],
    },
    {
        description: 'find a tarball Yarn 4 was refused',
        output: [
            '➤ YN0035: │ @formatjs/bigdecimal@npm:0.2.12: The remote server failed to provide the requested resource',
            '➤ YN0035: │   Response Code: 403 (Forbidden)',
            '➤ YN0035: │   Request Method: GET',
            `➤ YN0035: │   Request URL: ${MIRROR}/@formatjs/bigdecimal/-/bigdecimal-0.2.12.tgz`,
        ].join('\n'),
        expected: [{ name: '@formatjs/bigdecimal', version: '0.2.12' }],
    },
    {
        description: 'find a tarball Yarn 1 was refused',
        output: `error Error: ${MIRROR}/@formatjs/bigdecimal/-/bigdecimal-0.2.12.tgz: Request failed "403 Forbidden"`,
        expected: [{ name: '@formatjs/bigdecimal', version: '0.2.12' }],
    },
    {
        description: 'find a tarball npm was refused, with a hyphenated name and an encoded scope',
        output: `npm error 403 403 Forbidden - GET ${MIRROR}/@formatjs%2ffast-memoize/-/fast-memoize-3.1.8.tgz`,
        expected: [{ name: '@formatjs/fast-memoize', version: '3.1.8' }],
    },
    {
        description: 'find each refused version once',
        output: [
            '➤ YN0082: │ glob@npm:14.0.6: No candidates found',
            '➤ YN0082: │ glob@npm:14.0.6: No candidates found',
            'npm error notarget No matching version found for until-async@3.0.3-rc.1.',
        ].join('\n'),
        expected: [
            { name: 'glob', version: '14.0.6' },
            { name: 'until-async', version: '3.0.3-rc.1' },
        ],
    },
    {
        description: 'ignore tarball URLs that were not refused',
        output: [
            `Fetching ${MIRROR}/glob/-/glob-14.0.6.tgz`,
            'Done',
            'Linking',
            'Building',
            'Error: build failed with 403 warnings',
        ].join('\n'),
        expected: [],
    },
    {
        description: 'ignore version ranges',
        output: '➤ YN0082: │ glob@npm:^14.0.6: No candidates found',
        expected: [],
    },
];

describe('registry holds', () => {
    afterEach(() => {
        nock.cleanAll();
    });

    test.each(refusedCases)('should $description', ({ output, expected }) => {
        expect(findRefusedPackages(output)).toEqual(expected);
    });

    const NOW = Date.parse('2026-11-26T12:00:00.000Z');
    const HOUR_MS = 60 * 60 * 1_000;
    const OUTPUT = [
        '➤ YN0082: │ glob@npm:14.0.6: No candidates found',
        '➤ YN0082: │ rettime@npm:0.11.13: No candidates found',
    ].join('\n');

    const holdCases: {
        description: string;
        output: string;
        publishedAgoMs: Record<string, number | undefined>;
        expected: string[] | undefined;
    }[] = [
        {
            description: 'report a hold when every refused version is new',
            output: OUTPUT,
            publishedAgoMs: { glob: 40 * HOUR_MS, rettime: 1 * HOUR_MS },
            expected: ['glob@14.0.6', 'rettime@0.11.13'],
        },
        {
            description: 'report no hold when a refused version is past the hold',
            output: OUTPUT,
            publishedAgoMs: { glob: REGISTRY_HOLD_MS, rettime: 1 * HOUR_MS },
            expected: undefined,
        },
        {
            description: 'report no hold when npm does not know a refused version',
            output: OUTPUT,
            publishedAgoMs: { glob: 1 * HOUR_MS, rettime: undefined },
            expected: undefined,
        },
        {
            description: 'report no hold when the output names no refused version',
            output: 'Error: Cannot find module "vite"',
            publishedAgoMs: {},
            expected: undefined,
        },
    ];

    test.each(holdCases)('should $description', async ({ output, publishedAgoMs, expected }) => {
        const getPublishedAt: GetPublishedAt = async ({ name }) => {
            const ageMs = publishedAgoMs[name];
            return ageMs === undefined ? undefined : new Date(NOW - ageMs).toISOString();
        };

        const hold = await findRegistryHold({ getPublishedAt, now: NOW, output });

        const held = hold?.map(({ name, version }) => `${name}@${version}`);
        expect(held).toEqual(expected);
    });

    test('should read publish dates from the public npm registry', async () => {
        const scope = nock('https://registry.npmjs.org')
            .get('/@formatjs%2fbigdecimal')
            .reply(200, {
                time: {
                    '0.2.11': '2026-11-23T04:46:48.792Z',
                    '0.2.12': '2026-11-26T02:25:26.695Z',
                },
            });

        const known = await fetchNpmPublishedAt({
            name: '@formatjs/bigdecimal',
            version: '0.2.12',
        });

        expect(known).toBe('2026-11-26T02:25:26.695Z');
        expect(scope.isDone()).toBe(true);
    });
});
