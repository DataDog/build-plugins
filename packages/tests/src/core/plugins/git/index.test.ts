// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getRepositoryData } from '@dd/core/plugins/git/helpers';
import { getPlugins } from '@dd/telemetry-plugins';
import { defaultPluginOptions, getFetchMock, runBundlers } from '@dd/tests/helpers';

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

global.fetch = jest.fn(() => {
    return getFetchMock();
});

const getRepositoryDataMocked = jest.mocked(getRepositoryData);

describe('Git Plugin', () => {
    describe('It should run', () => {
        test('by default and add the relevant data to the context.', async () => {
            const pluginConfig = {
                ...defaultPluginOptions,
                telemetry: {},
            };
            const results = await runBundlers(pluginConfig);
            expect(getRepositoryDataMocked).toHaveBeenCalledTimes(results.length);

            // Confirm every call gets the git data in the context.
            for (const call of getPluginsMocked.mock.calls) {
                expect(call[1]).toMatchObject({
                    git: mockGitData,
                });
            }
        });
    });
    describe('It should not run', () => {
        test('if we disable it from the configuration', async () => {
            const pluginConfig = {
                ...defaultPluginOptions,
                disableGit: true,
            };
            await runBundlers(pluginConfig);
            expect(getRepositoryDataMocked).not.toHaveBeenCalled();
        });
    });
});
