// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { uploadSourcemaps } from '@dd/error-tracking-plugin/sourcemaps/index';
import { getPlugins } from '@dd/error-tracking-plugin';
import { getGetPluginsArg, getSourcemapsConfiguration } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';

jest.mock('@dd/error-tracking-plugin/sourcemaps/index', () => {
    return {
        uploadSourcemaps: jest.fn(),
    };
});

const uploadSourcemapsMock = jest.mocked(uploadSourcemaps);

describe('Error Tracking Plugin', () => {
    describe('getPlugins', () => {
        test('Should initialize the plugin', async () => {
            expect(getPlugins(getGetPluginsArg({ errorTracking: {} })).length).toBeGreaterThan(0);
        });
    });

    test('Should process the sourcemaps if enabled.', async () => {
        await runBundlers({
            enableGit: false,
            errorTracking: {
                sourcemaps: getSourcemapsConfiguration(),
            },
        });
        expect(uploadSourcemapsMock).toHaveBeenCalledTimes(BUNDLERS.length);
    });

    test('Should not process the sourcemaps with no options.', async () => {
        await runBundlers({
            enableGit: false,
            errorTracking: {},
        });

        expect(uploadSourcemapsMock).not.toHaveBeenCalled();
    });
});
