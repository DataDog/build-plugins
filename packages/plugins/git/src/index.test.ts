// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { LogLevel, Options, RepositoryData } from '@dd/core/types';
import { uploadSourcemaps } from '@dd/error-tracking-plugin/sourcemaps/index';
import { getRepositoryData } from '@dd/internal-git-plugin/helpers';
import {
    defaultPluginOptions,
    getRepositoryDataMock,
    getSourcemapsConfiguration,
} from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';

jest.mock('@dd/internal-git-plugin/helpers', () => {
    const originalModule = jest.requireActual('@dd/internal-git-plugin/helpers');
    return {
        ...originalModule,
        getRepositoryData: jest.fn(),
    };
});

jest.mock('@dd/error-tracking-plugin/sourcemaps/index', () => {
    const originalModule = jest.requireActual('@dd/error-tracking-plugin/sourcemaps/index');
    return {
        ...originalModule,
        uploadSourcemaps: jest.fn(),
    };
});

const uploadSourcemapsMocked = jest.mocked(uploadSourcemaps);
const getRepositoryDataMocked = jest.mocked(getRepositoryData);

const pluginOptions = {
    ...defaultPluginOptions,
    logLevel: 'error' as LogLevel,
    enableGit: true,
};

describe('Git Plugin', () => {
    describe('Enabled', () => {
        const mockGitData = getRepositoryDataMock();

        // Intercept contexts to verify it at the moment they're used.
        const gitReports: Record<string, RepositoryData | undefined> = {};
        const gitHookReports: Record<string, RepositoryData | undefined> = {};
        // Need to store it here as the mock gets cleared between tests (and beforeAll).
        let nbCallsToGetRepositoryData = 0;
        beforeAll(async () => {
            const pluginConfig: Options = {
                ...pluginOptions,
                errorTracking: {
                    // We need sourcemaps to trigger the git plugin.
                    sourcemaps: getSourcemapsConfiguration(),
                },
                customPlugins: ({ context }) => {
                    return [
                        {
                            name: 'custom-test-hook-plugin',
                            git(repoData) {
                                gitHookReports[context.bundler.name] = repoData;
                            },
                        },
                    ];
                },
            };

            uploadSourcemapsMocked.mockImplementation((options, context, log) => {
                gitReports[context.bundlerName] = context.git;
                return Promise.resolve();
            });

            getRepositoryDataMocked.mockImplementation(() => {
                nbCallsToGetRepositoryData += 1;
                return Promise.resolve(mockGitData);
            });

            await runBundlers(pluginConfig);
        });

        test('Should be called by default with sourcemaps configured.', async () => {
            expect(nbCallsToGetRepositoryData).toBe(BUNDLERS.length);
        });

        test.each(BUNDLERS)('[$name|$version] Should call the git hook.', async ({ name }) => {
            const gitReport = gitHookReports[name];
            expect(gitReport).toBeDefined();
            expect(gitReport).toMatchObject(mockGitData);
        });

        test.each(BUNDLERS)(
            '[$name|$version] Should add data to the context.',
            async ({ name }) => {
                const gitReport = gitReports[name];
                expect(gitReport).toBeDefined();
                expect(gitReport).toMatchObject(mockGitData);
            },
        );
    });

    describe('Erroring', () => {
        test('Should not throw with a git error.', async () => {
            const pluginConfig: Options = {
                ...pluginOptions,
                errorTracking: {
                    // We need sourcemaps to trigger the git plugin.
                    sourcemaps: getSourcemapsConfiguration(),
                },
            };

            getRepositoryDataMocked.mockImplementation(() => {
                throw new Error('Fake Error');
            });

            const { errors } = await runBundlers(pluginConfig);

            // Should have no errors.
            expect(errors).toHaveLength(0);

            // Should still call the function.
            expect(getRepositoryDataMocked).toHaveBeenCalledTimes(BUNDLERS.length);
        });
    });

    describe('Disabled', () => {
        test('Should not run by default without sourcemaps.', async () => {
            const pluginConfig = {
                ...pluginOptions,
            };
            await runBundlers(pluginConfig);
            expect(getRepositoryDataMocked).not.toHaveBeenCalled();
        });

        test('Should not run if we disable it from the configuration', async () => {
            const pluginConfig: Options = {
                ...pluginOptions,
                enableGit: false,
                errorTracking: {
                    sourcemaps: getSourcemapsConfiguration(),
                },
            };
            await runBundlers(pluginConfig);
            expect(getRepositoryDataMocked).not.toHaveBeenCalled();
        });
    });
});
