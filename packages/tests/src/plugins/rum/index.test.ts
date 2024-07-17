// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext } from '@dd/core/types';
import { uploadSourcemaps } from '@dd/rum-plugins/sourcemaps/index';
import { BUNDLERS, runBundlers } from '@dd/tests/helpers/runBundlers';

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
        expect(uploadSourcemapsMock).toHaveBeenCalledTimes(BUNDLERS.length);
    });

    test('It should process the sourcemaps with the right context.', async () => {
        const contextResults: GlobalContext[] = [];
        // Intercept context to verify it at the moment it's sent.
        uploadSourcemapsMock.mockImplementation((options, context, log) => {
            contextResults.push({ ...context });
            return Promise.resolve();
        });

        await runBundlers({
            rum: {
                sourcemaps: getSourcemapsConfiguration(),
            },
        });

        expect(contextResults).toHaveLength(BUNDLERS.length);
        for (const context of contextResults) {
            expect(context.outputFiles).toBeDefined();
            expect(context.outputFiles?.length).toBeGreaterThan(0);
        }
    });

    test('It should not process the sourcemaps with no options.', async () => {
        await runBundlers({
            rum: {},
        });

        expect(uploadSourcemapsMock).not.toHaveBeenCalled();
    });
});
