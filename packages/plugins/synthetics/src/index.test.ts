// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getPlugins } from '@dd/synthetics-plugin';
import { getContextMock } from '@dd/tests/_jest/helpers/mocks';
import { runBundlers } from '@dd/tests/_jest/helpers/runBundlers';

describe('Synthetics Plugin', () => {
    describe('getPlugins', () => {
        test('Should not initialize the plugin if disabled', async () => {
            expect(getPlugins({ synthetics: { disabled: true } }, getContextMock())).toHaveLength(
                0,
            );
        });

        test('Should initialize the plugin if enabled and not configured', async () => {
            expect(
                getPlugins({ synthetics: { disabled: false } }, getContextMock()).length,
            ).toBeGreaterThan(0);
            expect(getPlugins({}, getContextMock()).length).toBeGreaterThan(0);
        });
    });

    test('Should run the server at the end of the build.', async () => {
        await runBundlers({
            logLevel: 'debug',
        });
    });
});
