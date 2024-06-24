// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { uploadSourcemaps } from '@dd/rum-plugins/sourcemaps/index';
import { runBundlers } from '@dd/tests/helpers';

import { getSourcemapsConfiguration } from './testHelpers';

jest.mock('@dd/rum-plugins/sourcemaps/index', () => {
    return {
        uploadSourcemaps: jest.fn(),
    };
});

const uploadSourcemapsMock = jest.mocked(uploadSourcemaps);

describe('RUM Plugin', () => {
    test('It should process the sourcemaps if enabled.', async () => {
        await runBundlers({
            rum: {
                sourcemaps: getSourcemapsConfiguration(),
            },
        });

        expect(uploadSourcemapsMock).toHaveBeenCalled();
    });
    test('It should not process the sourcemaps with no options.', async () => {
        await runBundlers({
            rum: {},
        });

        expect(uploadSourcemapsMock).not.toHaveBeenCalled();
    });
});
