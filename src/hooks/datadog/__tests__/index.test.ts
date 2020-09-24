// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

describe('Datadog Hook', () => {
    const buildPluginMock = {
        options: {},
    };
    const statsMock = {
        modules: [],
        chunks: [],
        assets: [],
        warnings: [],
        errors: [],
        entrypoints: {},
    };
    const reportMock = {
        timings: {
            tapables: {},
            loaders: {},
        },
        dependencies: {},
    };

    test('It should not fail given undefined options', async () => {
        const { hooks } = require('../index');
        const obj = await hooks.preoutput.call(buildPluginMock, {
            report: reportMock,
            stats: { toJson: () => statsMock },
        });

        expect(typeof obj).toBe('object');
    });

    test('It should export hooks', () => {
        const datadog = require('../index');
        expect(typeof datadog.hooks).toBe('object');
    });
});
