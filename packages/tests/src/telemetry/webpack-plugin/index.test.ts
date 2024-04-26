// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import webpackPlugin from '@datadog/webpack-plugin';

import { mockCompiler, mockOptions } from '../../testHelpers';

describe('webpack', () => {
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

        const plugin = webpackPlugin({
            ...mockOptions,
            telemetry: {
                disabled: true,
            },
        });

        plugin.apply(compiler);

        expect(compiler.hooks.thisCompilation.tap).not.toHaveBeenCalled();
    });
});
