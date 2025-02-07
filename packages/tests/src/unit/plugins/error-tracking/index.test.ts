// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { uploadSourcemaps } from '@dd/error-tracking-plugin/sourcemaps/index';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import type { CleanupFn } from '@dd/tests/_jest/helpers/types';

import { getSourcemapsConfiguration } from './testHelpers';

jest.mock('@dd/error-tracking-plugin/sourcemaps/index', () => {
    return {
        uploadSourcemaps: jest.fn(),
    };
});

const uploadSourcemapsMock = jest.mocked(uploadSourcemaps);

describe('Error Tracking Plugin', () => {
    const cleanups: CleanupFn[] = [];

    afterAll(async () => {
        await Promise.all(cleanups.map((cleanup) => cleanup()));
    });

    test('Should process the sourcemaps if enabled.', async () => {
        cleanups.push(
            await runBundlers({
                errorTracking: {
                    sourcemaps: getSourcemapsConfiguration(),
                },
            }),
        );
        expect(uploadSourcemapsMock).toHaveBeenCalledTimes(BUNDLERS.length);
    });

    test('Should not process the sourcemaps with no options.', async () => {
        cleanups.push(
            await runBundlers({
                errorTracking: {},
            }),
        );

        expect(uploadSourcemapsMock).not.toHaveBeenCalled();
    });
});
