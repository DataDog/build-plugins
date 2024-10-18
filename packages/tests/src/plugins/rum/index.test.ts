// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { uploadSourcemaps } from '@dd/rum-plugins/sourcemaps/index';
import { BUNDLERS, runBundlers } from '@dd/tests/helpers/runBundlers';
import type { CleanupFn } from '@dd/tests/helpers/types';

import { getSourcemapsConfiguration } from './testHelpers';

jest.mock('@dd/rum-plugins/sourcemaps/index', () => {
    return {
        uploadSourcemaps: jest.fn(),
    };
});

const uploadSourcemapsMock = jest.mocked(uploadSourcemaps);

describe('RUM Plugin', () => {
    const cleanups: CleanupFn[] = [];

    afterAll(async () => {
        await Promise.all(cleanups.map((cleanup) => cleanup()));
    });

    test('Should process the sourcemaps if enabled.', async () => {
        cleanups.push(
            await runBundlers({
                rum: {
                    sourcemaps: getSourcemapsConfiguration(),
                },
            }),
        );
        expect(uploadSourcemapsMock).toHaveBeenCalledTimes(BUNDLERS.length);
    });

    test('Should not process the sourcemaps with no options.', async () => {
        cleanups.push(
            await runBundlers({
                rum: {},
            }),
        );

        expect(uploadSourcemapsMock).not.toHaveBeenCalled();
    });
});
