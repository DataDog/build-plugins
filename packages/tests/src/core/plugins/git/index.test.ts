// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getRepositoryData } from '@dd/core/plugins/git/helpers';
import { TrackedFilesMatcher } from '@dd/core/plugins/git/trackedFilesMatcher';
import type { RepositoryData } from '@dd/core/types';
import { uploadSourcemaps } from '@dd/rum-plugins/sourcemaps/index';
import { defaultPluginOptions } from '@dd/tests/helpers/mocks';
import type { CleanupFn } from '@dd/tests/helpers/runBundlers';
import { BUNDLERS, runBundlers } from '@dd/tests/helpers/runBundlers';
import { API_PATH, FAKE_URL, getSourcemapsConfiguration } from '@dd/tests/plugins/rum/testHelpers';
import nock from 'nock';

jest.mock('@dd/core/plugins/git/helpers', () => {
    const originalModule = jest.requireActual('@dd/core/plugins/git/helpers');
    return {
        ...originalModule,
        getRepositoryData: jest.fn(),
    };
});

jest.mock('@dd/rum-plugins/sourcemaps/index', () => {
    const originalModule = jest.requireActual('@dd/rum-plugins/sourcemaps/index');
    return {
        ...originalModule,
        uploadSourcemaps: jest.fn(),
    };
});

const uploadSourcemapsMocked = jest.mocked(uploadSourcemaps);

const getRepositoryDataMocked = jest.mocked(getRepositoryData);

describe('Git Plugin', () => {
    beforeAll(() => {
        // Mock requests.
        nock(FAKE_URL).post(API_PATH).reply(200, {}).persist();
    });

    afterAll(() => {
        nock.cleanAll();
    });

    describe('Enabled', () => {
        const mockGitData: RepositoryData = {
            hash: 'hash',
            remote: 'remote',
            trackedFilesMatcher: new TrackedFilesMatcher([]),
        };

        // Intercept contexts to verify it at the moment they're used.
        const gitReports: Record<string, RepositoryData | undefined> = {};
        // Need to store it here as the mock gets cleared between tests (and beforeAll).
        let nbCallsToGetRepositoryData = 0;
        let cleanup: CleanupFn;
        beforeAll(async () => {
            const pluginConfig = {
                ...defaultPluginOptions,
                rum: {
                    // We need sourcemaps to trigger the git plugin.
                    sourcemaps: getSourcemapsConfiguration(),
                },
            };

            uploadSourcemapsMocked.mockImplementation((options, context, log) => {
                gitReports[context.bundler.fullName] = context.git;
                return Promise.resolve();
            });

            getRepositoryDataMocked.mockImplementation(() => {
                nbCallsToGetRepositoryData += 1;
                return Promise.resolve(mockGitData);
            });

            cleanup = await runBundlers(pluginConfig);
        });

        afterAll(async () => {
            await cleanup();
        });

        test('Should be called by default with sourcemaps configured.', async () => {
            expect(nbCallsToGetRepositoryData).toBe(BUNDLERS.length);
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

    describe('Disabled', () => {
        const cleanups: CleanupFn[] = [];

        afterAll(async () => {
            await Promise.all(cleanups.map((cleanup) => cleanup()));
        });

        test('Should not run by default without sourcemaps.', async () => {
            const pluginConfig = {
                ...defaultPluginOptions,
            };
            cleanups.push(await runBundlers(pluginConfig));
            expect(getRepositoryDataMocked).not.toHaveBeenCalled();
        });

        test('Should not run if we disable it from the configuration', async () => {
            const pluginConfig = {
                ...defaultPluginOptions,
                rum: {
                    sourcemaps: getSourcemapsConfiguration(),
                },
                disableGit: true,
            };
            cleanups.push(await runBundlers(pluginConfig));
            expect(getRepositoryDataMocked).not.toHaveBeenCalled();
        });
    });
});
