// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getRepositoryData } from '@dd/internal-git-plugin/helpers';
import { vol } from 'memfs';

jest.mock('fs', () => require('memfs').fs);

describe('Git Plugin helpers', () => {
    describe('GetRepositoryData', () => {
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
            raw: (arg: string) => 'src/core/plugins/git/helpers.test.ts',
            revparse: (arg: string) => '25da22df90210a40b919debe3f7ebfb0c1811898',
        });

        test('Should return the relevant data from git', async () => {
            const data = await getRepositoryData(createMockSimpleGit() as any, '');
            if (!data) {
                fail('data should not be undefined');
            }

            const files = data.trackedFilesMatcher.matchSourcemap(
                'fixtures/common.min.js.map',
                () => undefined,
            );
            expect(data.remote).toBe('git@github.com:user/repository.git');
            expect(data.hash).toBe('25da22df90210a40b919debe3f7ebfb0c1811898');
            expect(files).toStrictEqual(['src/core/plugins/git/helpers.test.ts']);
        });

        test('Should return the relevant data from git with a different remote', async () => {
            const data = await getRepositoryData(
                createMockSimpleGit() as any,
                'git@github.com:user/other.git',
            );
            if (!data) {
                fail('data should not be undefined');
            }
            const files = data.trackedFilesMatcher.matchSourcemap(
                'fixtures/common.min.js.map',
                () => undefined,
            );
            expect(data.remote).toBe('git@github.com:user/other.git');
            expect(data.hash).toBe('25da22df90210a40b919debe3f7ebfb0c1811898');
            expect(files).toStrictEqual(['src/core/plugins/git/helpers.test.ts']);
        });
    });
});
