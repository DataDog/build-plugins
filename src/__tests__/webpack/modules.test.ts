// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { LocalModule, Module, Compilation, Chunk } from '../../types';
import { Modules } from '../../webpack/modules';
import { mockLocalOptions } from '../helpers/testHelpers';

describe('Modules', () => {
    // Webpack5 is actually throwing an error when using this property.
    const getThrowingDependency = (dep: any) => {
        Object.defineProperty(dep, 'module', {
            get: () => {
                throw new Error();
            },
        });
        return dep;
    };

    const getMockedModule = (opts?: {
        name?: Module['name'];
        size?: Module['size'];
        _chunks?: Module['_chunks'];
        dependencies?: Module['dependencies'];
    }): Module => ({
        name: (opts && opts.name) || 'Name',
        size: (opts && opts.size) || 1,
        loaders: [],
        chunks: [],
        _chunks: (opts && opts._chunks) || new Set(),
        dependencies: (opts && opts.dependencies) || [],
    });

    const getMockedChunk = (opts?: { names?: string[] }): Chunk => ({
        id: 'id',
        size: 0,
        modules: [{}],
        files: ['file'],
        names: ['name'],
        parents: (opts && opts.names) || ['parent'],
    });

    const mockedModules: Module[] = [
        getMockedModule({
            name: 'moduleWebpack4',
            size: 50,
            _chunks: new Set([
                getMockedChunk({ names: ['chunk1'] }),
                getMockedChunk({ names: ['chunk2'] }),
            ]),
            dependencies: [
                { module: getMockedModule({ name: 'dep1', size: 1 }) },
                { module: getMockedModule({ name: 'dep2', size: 2 }) },
                { module: getMockedModule({ name: 'dep3', size: 3 }) },
            ],
        }),
        getMockedModule({
            name: 'moduleWebpack5',
            size: () => 50,
            dependencies: [
                getThrowingDependency({ name: 'dep1', size: () => 1 }),
                getThrowingDependency({ name: 'dep2', size: () => 2 }),
                getThrowingDependency({ name: 'dep3', size: () => 3 }),
            ],
        }),
        getMockedModule({ name: 'dep1', size: () => 1 }),
        getMockedModule({ name: 'dep2', size: () => 2 }),
        getMockedModule({ name: 'dep3', size: () => 3 }),
    ];

    const mockCompilation: Compilation = {
        options: { context: '' },
        moduleGraph: {
            getIssuer: () => getMockedModule(),
            issuer: getMockedModule(),
            getModule(dep: any) {
                return mockedModules[0].dependencies.find(
                    (d) => d.module.name === dep.name && d.module
                )!.module;
            },
        },
        chunkGraph: {
            getModuleChunks(module: any) {
                return mockedModules[0]._chunks;
            },
        },
        hooks: {
            buildModule: { tap: () => {} },
            succeedModule: { tap: () => {} },
            afterOptimizeTree: { tap: () => {} },
        },
    };

    const modules = new Modules(mockLocalOptions);
    modules.afterOptimizeTree({}, mockedModules, mockCompilation);

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
