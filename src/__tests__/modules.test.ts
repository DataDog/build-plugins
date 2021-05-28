// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { LocalModule } from '../types';

describe('Modules', () => {
    const { Modules } = require('../modules');
    // Webpack5 is actually throwing an error when using this property.
    const getThrowingDependency = (dep: any) => {
        Object.defineProperty(dep, 'module', {
            get: () => {
                throw new Error();
            },
        });
        return dep;
    };
    const mockedModules = [
        {
            name: 'moduleWebpack4',
            size: 50,
            _chunks: new Set([{ name: 'chunk1' }, { name: 'chunk2' }]),
            dependencies: [
                { name: 'dep1', module: { name: 'dep1' }, size: 1 },
                { name: 'dep2', size: 2 },
                { name: 'dep3', module: { name: 'dep3' }, size: 3 },
            ],
        },
        {
            name: 'moduleWebpack5',
            size: () => 50,
            dependencies: [
                getThrowingDependency({ name: 'dep1', size: () => 1 }),
                getThrowingDependency({ name: 'dep2', size: () => 2 }),
                getThrowingDependency({ name: 'dep3', size: () => 3 }),
            ],
        },
        { name: 'dep1', size: () => 1, dependencies: [] },
        { name: 'dep2', size: () => 2, dependencies: [] },
        { name: 'dep3', size: () => 3, dependencies: [] },
    ];

    const mockCompilation = {
        moduleGraph: {
            getModule(dep: any) {
                return mockedModules[0].dependencies.find((d) => d.name === dep.name && d.module);
            },
        },
        chunkGraph: {
            getModuleChunks(module: any) {
                return mockedModules[0]._chunks;
            },
        },
    };

    const modules = new Modules();
    modules.afterOptimizeTree({}, mockedModules, '/', mockCompilation);

    test('It should filter modules the same with Webpack 5 and 4', () => {
        const modulesWebpack4 = modules.storedModules['moduleWebpack4'].dependencies;
        const modulesWebpack5 = modules.storedModules['moduleWebpack5'].dependencies;

        expect(modulesWebpack5.length).toBe(modulesWebpack4.length);
    });

    test('It should add module size to the results', () => {
        const results = modules.getResults();
        for (const module of Object.values(results.modules) as LocalModule[]) {
            expect(module.size).toBeDefined();
        }
    });

    test('It should add chunk names to the results', () => {
        const results = modules.getResults();
        for (const module of Object.values(results.modules) as LocalModule[]) {
            expect(module.chunkNames).toBeDefined();
        }
    });
});
