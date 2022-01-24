// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { BundlerStats, Stats, Report, Compilation, Compiler } from '../../types';

export const mockStats = ({
    toJson: jest.fn(() => ({
        modules: [],
        chunks: [],
        assets: [],
        entrypoints: {},
        warnings: [],
        errors: [],
        time: 0,
    })),
    endTime: 0,
    startTime: 0,
    compilation: {
        assets: {},
        fileDependencies: new Set(),
        emittedAssets: new Set(),
        warnings: [],
        modules: new Set(),
        chunks: new Set(),
        entries: new Map(),
    },
} as unknown) as Stats;

export const mockBundler: BundlerStats = {
    webpack: mockStats,
    esbuild: {
        warnings: [],
        errors: [],
        entrypoints: [],
        duration: 0,
        inputs: {},
        outputs: {},
    },
};

export const mockReport = {
    timings: {
        tapables: new Map(),
        loaders: new Map(),
        modules: new Map(),
    },
    dependencies: {},
} as Report;

const mockTapable = { tap: jest.fn() };
export const mockCompilation = {
    options: {
        context: '/default/context',
    },
    hooks: {
        buildModule: mockTapable,
        succeedModule: mockTapable,
        afterOptimizeTree: mockTapable,
    },
} as Compilation;

export const mockCompiler = {
    hooks: {
        thisCompilation: {
            tap: (opts: any, cb: (c: Compilation) => void) => {
                cb(mockCompilation);
            },
        },
        done: {
            tapPromise: (opts: any, cb: any) => cb(mockStats),
        },
    },
} as Compiler;
