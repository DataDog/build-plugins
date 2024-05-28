// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { mockBuild, mockOptions } from '@dd/tests/testHelpers';

describe('Telemetry ESBuild Plugin', () => {
    test('It should not execute if disabled', () => {
        const plugin = datadogEsbuildPlugin({
            ...mockOptions,
            telemetry: { disabled: true },
        });

        plugin.setup(mockBuild);

        expect(mockBuild.onEnd).not.toHaveBeenCalled();
    });
});
