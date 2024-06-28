// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getRepositoryData } from '@dd/core/plugins/git/helpers';
import { getPlugins } from '@dd/telemetry-plugins';
import { defaultPluginOptions, runBundlers } from '@dd/tests/helpers';
import { API_PATH, FAKE_URL, getSourcemapsConfiguration } from '@dd/tests/plugins/rum/testHelpers';
import nock from 'nock';

jest.mock('@dd/telemetry-plugins', () => {
    const originalModule = jest.requireActual('@dd/telemetry-plugins');
    return {
        ...originalModule,
        getPlugins: jest.fn(() => []),
    };
});

const getPluginsMocked = jest.mocked(getPlugins);
const mockGitData = {
    data: 'data',
};

jest.mock('@dd/core/plugins/git/helpers', () => {
    const originalModule = jest.requireActual('@dd/core/plugins/git/helpers');
    return {
        ...originalModule,
        getRepositoryData: jest.fn(() => Promise.resolve(mockGitData)),
    };
});

const getRepositoryDataMocked = jest.mocked(getRepositoryData);

describe('Git Plugin', () => {
    beforeAll(() => {
        // Mock requests.
        nock(FAKE_URL).post(API_PATH).reply(200, {}).persist();
    });
    afterAll(() => {
        nock.cleanAll();
    });
    describe('It should run', () => {
        test('by default with sourcemaps.', async () => {
            const pluginConfig = {
                ...defaultPluginOptions,
                rum: {
                    sourcemaps: getSourcemapsConfiguration(),
                },
            };
            const results = await runBundlers(pluginConfig);
            expect(getRepositoryDataMocked).toHaveBeenCalledTimes(results.length);
        });

        test('and add the relevant data to the context.', async () => {
            const pluginConfig = {
                ...defaultPluginOptions,
                telemetry: {},
                rum: {
                    sourcemaps: getSourcemapsConfiguration(),
                },
            };

            await runBundlers(pluginConfig);

            // Confirm every call gets the git data in the context.
            for (const call of getPluginsMocked.mock.calls) {
                expect(call[1]).toMatchObject({
                    git: mockGitData,
                });
            }
        });
    });
    describe('It should not run', () => {
        test('by default without sourcemaps.', async () => {
            const pluginConfig = {
                ...defaultPluginOptions,
            };
            await runBundlers(pluginConfig);
            expect(getRepositoryDataMocked).not.toHaveBeenCalled();
        });
        test('if we disable it from the configuration', async () => {
            const pluginConfig = {
                ...defaultPluginOptions,
                rum: {
                    sourcemaps: getSourcemapsConfiguration(),
                },
                disableGit: true,
            };
            await runBundlers(pluginConfig);
            expect(getRepositoryDataMocked).not.toHaveBeenCalled();
        });
    });
});
