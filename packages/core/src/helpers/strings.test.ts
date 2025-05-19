// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

describe('Strings Helpers', () => {
    describe('formatDuration', () => {
        test.each([
            [0, '0ms'],
            [10, '10ms'],
            [10000, '10s'],
            [10010, '10s 10ms'],
            [1000000, '16m 40s'],
            [1000010, '16m 40s 10ms'],
            [10000000, '2h 46m 40s'],
            [10000010, '2h 46m 40s 10ms'],
            [1000000000, '11d 13h 46m 40s'],
            [1000000010, '11d 13h 46m 40s 10ms'],
        ])('Should format duration %s => %s', async (ms, expected) => {
            const { formatDuration } = await import('@dd/core/helpers/strings');
            expect(formatDuration(ms)).toBe(expected);
        });
    });

    describe('truncateString', () => {
        test.each([
            // No truncation needed.
            ['Short string', 20, '[...]', 'Short string'],
            // Keep at least 2 characters on each side.
            ['Short string', 2, '[...]', 'Sh[...]ng'],
            // Equaly truncate on both sides.
            [
                'A way too long sentence could be truncated a bit.',
                20,
                '[...]',
                'A way t[...]d a bit.',
            ],
            // Custom placeholder.
            [
                'A way too long sentence could be truncated a bit.',
                20,
                '***',
                'A way to***ed a bit.',
            ],
            // Longer sentence.
            [
                'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
                50,
                '[...]',
                'Lorem ipsu[...]t ut labore et dolore magna aliqua.',
            ],
        ])(
            'Should truncate string "%s" to max length %d with placeholder "%s" => "%s"',
            async (str, maxLength, placeholder, expected) => {
                const { truncateString } = await import('@dd/core/helpers/strings');
                expect(truncateString(str, maxLength, placeholder)).toBe(expected);
            },
        );
    });

    describe('filterSensitiveInfoFromRepositoryUrl', () => {
        test.each([
            {
                description: 'return empty string when input is empty',
                input: '',
                expected: '',
            },
            {
                description: 'not modify git@ URLs',
                input: 'git@github.com:user/repository.git',
                expected: 'git@github.com:user/repository.git',
            },
            {
                description: 'strip username and password from https URLs',
                input: 'https://user:password@github.com/user/repository.git',
                expected: 'https://github.com/user/repository.git',
            },
            {
                description: 'strip username and password from ssh URLs',
                input: 'ssh://user:password@github.com/user/repository.git',
                expected: 'ssh://github.com/user/repository.git',
            },
            {
                description: 'strip username and password from ftp URLs',
                input: 'ftp://user:password@github.com/user/repository.git',
                expected: 'ftp://github.com/user/repository.git',
            },
            {
                description: 'handle URLs with no credentials',
                input: 'https://github.com/user/repository.git',
                expected: 'https://github.com/user/repository.git',
            },
            {
                description: 'handle URLs with port',
                input: 'https://github.com:8080/user/repository.git',
                expected: 'https://github.com:8080/user/repository.git',
            },
            {
                description: 'remove root pathname',
                input: 'https://github.com/',
                expected: 'https://github.com',
            },
            {
                description: 'handle URLs with only host',
                input: 'github.com',
                expected: 'github.com',
            },
            {
                description: 'keep invalid URLs unchanged',
                input: 'invalid-url',
                expected: 'invalid-url',
            },
        ])('Should $description', async ({ input, expected }) => {
            const { filterSensitiveInfoFromRepositoryUrl } = await import(
                '@dd/core/helpers/strings'
            );
            expect(filterSensitiveInfoFromRepositoryUrl(input)).toBe(expected);
        });
    });
});
