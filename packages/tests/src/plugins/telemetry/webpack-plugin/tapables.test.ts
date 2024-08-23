// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Tapable } from '@dd/telemetry-plugins/types';
import { Tapables } from '@dd/telemetry-plugins/webpack-plugin/tapables';

describe('Telemetry Webpack Tapables', () => {
    test('It should not crash with read-only hooks', () => {
        const tapables = new Tapables('');

        const mockTapable: Tapable = {
            hooks: {
                hook1: Object.freeze({
                    tap: () => {},
                    tapAsync: () => {},
                    tapPromise: () => Promise.resolve(),
                }),
            },
        };

        expect(() => {
            tapables.throughHooks(mockTapable);
        }).not.toThrow();
    });
});
