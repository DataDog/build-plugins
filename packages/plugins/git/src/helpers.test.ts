// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    getRepositoryData,
    filterSensitiveInfoFromRepositoryUrl,
} from '@dd/internal-git-plugin/helpers';
import { vol } from 'memfs';

jest.mock('fs', () => require('memfs').fs);

describe('Git Plugin helpers', () => {
    describe('getRepositoryData', () => {
        beforeEach(() => {
            // Emulate some fixtures.
            vol.fromJSON({
                'fixtures/common.min.js.map': JSON.stringify(
                    {
                        sources: ['webpack:///./src/core/plugins/git/helpers.test.ts'],
                    },
                    null,
                    2,
                ),
            });
        });

        afterEach(() => {
            vol.reset();
        });

        const createMockSimpleGit = () => ({
            getConfig: (arg: string) => ({ value: 'origin' }),
            getRemotes: (arg: boolean) => [
                { refs: { push: 'git@github.com:user/repository.git' } },
            ],
            branch: () => ({ current: 'main' }),
            show: ([, format]: [string, string]) => {
                if (format === '--format=%s') {
                    return 'test message ';
                }
                if (format === '--format=%an,%ae,%aI,%cn,%ce,%cI') {
                    return 'John Doe ,john.doe@example.com,2021-01-01 ,Jane Smith,jane.smith@example.com,2021-01-02';
                }
                return '';
            },
            raw: (arg: string) => 'src/core/plugins/git/helpers.test.ts',
            revparse: (arg: string) => '25da22df90210a40b919debe3f7ebfb0c1811898',
        });

        test('Should return the relevant data from git', async () => {
            const data = await getRepositoryData(createMockSimpleGit() as any);
            if (!data) {
                fail('data should not be undefined');
            }

            const files = data.trackedFilesMatcher.matchSourcemap(
                'fixtures/common.min.js.map',
                () => undefined,
            );
            expect(data.remote).toBe('git@github.com:user/repository.git');
            expect(data.commit.hash).toBe('25da22df90210a40b919debe3f7ebfb0c1811898');
            expect(data.commit.message).toBe('test message');
            expect(data.commit.author.name).toBe('John Doe');
            expect(data.commit.author.email).toBe('john.doe@example.com');
            expect(data.commit.author.date).toBe('2021-01-01');
            expect(data.commit.committer.name).toBe('Jane Smith');
            expect(data.commit.committer.email).toBe('jane.smith@example.com');
            expect(data.commit.committer.date).toBe('2021-01-02');
            expect(data.branch).toBe('main');
            expect(files).toStrictEqual(['src/core/plugins/git/helpers.test.ts']);
        });
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
        ])('Should $description', ({ input, expected }) => {
            expect(filterSensitiveInfoFromRepositoryUrl(input)).toBe(expected);
        });
    });
});
