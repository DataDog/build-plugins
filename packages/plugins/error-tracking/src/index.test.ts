// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { uploadSourcemaps } from '@dd/error-tracking-plugin/sourcemaps/index';
import { getSourcemapsConfiguration } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';

jest.mock('@dd/error-tracking-plugin/sourcemaps/index', () => {
    return {
        uploadSourcemaps: jest.fn(),
    };
});

const uploadSourcemapsMock = jest.mocked(uploadSourcemaps);

describe('Error Tracking Plugin', () => {
    test('Should process the sourcemaps if enabled.', async () => {
        await runBundlers({
            disableGit: true,
            errorTracking: {
                sourcemaps: getSourcemapsConfiguration(),
            },
        });
        expect(uploadSourcemapsMock).toHaveBeenCalledTimes(BUNDLERS.length);
    });

    test('Should not process the sourcemaps with no options.', async () => {
        await runBundlers({
            disableGit: true,
            errorTracking: {},
        });

        expect(uploadSourcemapsMock).not.toHaveBeenCalled();
    });
});
