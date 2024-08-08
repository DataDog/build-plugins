// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

describe('Telemetry Webpack Tapables', () => {
    test('It should not crash with read-only hooks', () => {
        const { Tapables } = require('@dd/telemetry-plugins/webpack-plugin/tapables');
        const tapables = new Tapables();

        const mockTapable = {
            hooks: {
                hook1: Object.freeze({
                    tap: () => {},
                    tapAsync: () => {},
                    tapPromise: () => {},
                }),
            },
        };

        expect(() => {
            tapables.throughHooks(mockTapable);
        }).not.toThrow();
    });
});
