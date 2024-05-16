// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogWebpackPlugin } from '@datadog/webpack-plugin';
import { mockCompiler, mockOptions } from '@dd/tests/testHelpers';

describe('Telemetry Webpack Plugin', () => {
    test('It should not execute if disabled', () => {
        const compiler = {
            ...mockCompiler,
            hooks: {
                thisCompilation: {
                    ...mockCompiler.hooks.thisCompilation,
                    tap: jest.fn(),
                },
            },
        };

        const plugin = datadogWebpackPlugin({
            ...mockOptions,
            telemetry: {
                disabled: true,
            },
        });

        // @ts-expect-error - webpack 4 and 5 nonsense.
        plugin.apply(compiler);

        expect(compiler.hooks.thisCompilation.tap).not.toHaveBeenCalled();
    });
});
