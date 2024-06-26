// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

describe('Telemetry Renderer', () => {
    test('It should outputWebpack the same with Webpack 5 and 4', () => {
        const { outputWebpack } = require('@dd/telemetry-plugins/common/output/text');

        const ar = [{ name: 'element1' }, { name: 'element2' }];
        const obj = { obj0: ar[0], obj1: ar[1] };
        const set = new Set(ar);
        const map = new Map();
        map.set(0, ar[0]);
        map.set(1, ar[1]);

        const statsDefault = {
            endTime: 0,
            startTime: 0,
            compilation: {
                warnings: ar,
                fileDependencies: set,
            },
        };
        const statsWebpack4 = {
            ...statsDefault,
            compilation: {
                ...statsDefault.compilation,
                assets: obj,
                modules: ar,
                entries: ar,
                chunks: ar,
            },
        };
        const statsWebpack5 = {
            ...statsDefault,
            compilation: {
                ...statsDefault.compilation,
                emittedAssets: set,
                modules: set,
                entries: map,
                chunks: set,
            },
        };
        const outputWebpack4 = outputWebpack(statsWebpack4);
        const outputWebpack5 = outputWebpack(statsWebpack5);

        expect(outputWebpack4).toBe(outputWebpack5);
    });
});
