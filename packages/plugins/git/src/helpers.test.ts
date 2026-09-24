// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getRepositoryData, gitRemote } from '@dd/internal-git-plugin/helpers';
import { addFixtureFiles } from '@dd/tests/_jest/helpers/mocks';

jest.mock('@dd/core/helpers/fs', () => {
    const original = jest.requireActual('@dd/core/helpers/fs');
    return {
        ...original,
        readFileSync: jest.fn(),
    };
});

describe('Git Plugin helpers', () => {
    describe('getRepositoryData', () => {
        beforeEach(() => {
            // Emulate some fixtures.
            addFixtureFiles({
                './fixtures/common.min.js.map': JSON.stringify(
                    {
                        sources: ['webpack:///./src/core/plugins/git/helpers.test.ts'],
                    },
                    null,
                    2,
                ),
            });
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

        test.each([
            [undefined, 'git@github.com:user/repository.git'],
            ['', 'git@github.com:user/repository.git'],
            ['   ', 'git@github.com:user/repository.git'],
            ['https://github.com/user/canonical', 'https://github.com/user/canonical'],
            [
                ' https://user:password@github.com/user/canonical?token=secret#fragment ',
                'https://github.com/user/canonical',
            ],
            ['git@github.com:user/canonical.git', 'git@github.com:user/canonical.git'],
        ])('Should use URL %s and preserve the other Git data', async (override, remote) => {
            const data = await getRepositoryData(createMockSimpleGit() as any, override);
            if (!data) {
                throw new Error('data should not be undefined');
            }

            const files = data.trackedFilesMatcher.matchSourcemap(
                'fixtures/common.min.js.map',
                () => undefined,
            );
            expect(data.remote).toBe(remote);
            expect(data.hash).toBe('25da22df90210a40b919debe3f7ebfb0c1811898');
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

        test('Should not discover remotes when a repository URL is provided', async () => {
            const git = { ...createMockSimpleGit(), getRemotes: jest.fn(() => []) };
            const data = await getRepositoryData(git as any, 'https://github.com/user/canonical');

            expect(data.remote).toBe('https://github.com/user/canonical');
            expect(git.getRemotes).not.toHaveBeenCalled();
        });
    });

    describe('gitRemote', () => {
        test('Should reject when no remotes are available', async () => {
            const mockGitNoRemotes = {
                getConfig: (arg: string) => ({ value: 'origin' }),
                getRemotes: (arg: boolean) => [],
            };

            await expect(gitRemote(mockGitNoRemotes as any)).rejects.toThrow(
                'No git remotes available',
            );
        });
    });
});
