// Unless explicitly stated otherwise all files in this repository are licensed under the Apache License Version 2.0.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

describe('Renderer', () => {
    test('It should outputGenerals the same with Webpack 5 and 4', () => {
        const { outputGenerals } = require('../renderer');

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
        const outputWebpack4 = outputGenerals(statsWebpack4);
        const outputWebpack5 = outputGenerals(statsWebpack5);

        expect(outputWebpack4).toBe(outputWebpack5);
    });

    test('It should export hooks', () => {
        const renderer = require('../renderer');
        expect(typeof renderer.hooks).toBe('object');
    });
});
