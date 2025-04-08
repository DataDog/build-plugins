// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getPlugins } from '@dd/ci-visibility-plugin';
import { getContextMock } from '@dd/tests/_jest/helpers/mocks';

describe('Ci Visibility Plugin', () => {
    describe('getPlugins', () => {
        test('Should not initialize the plugin if disabled', async () => {
            expect(
                getPlugins({
                    options: { ciVisibility: { disabled: true } },
                    context: getContextMock(),
                    bundler: {},
                }),
            ).toHaveLength(0);
            expect(
                getPlugins({ options: {}, context: getContextMock(), bundler: {} }),
            ).toHaveLength(0);
        });

        test('Should initialize the plugin if enabled', async () => {
            expect(
                getPlugins({
                    options: { ciVisibility: { disabled: false } },
                    context: getContextMock(),
                    bundler: {},
                }),
            ).toHaveLength(0);
        });
    });
});
