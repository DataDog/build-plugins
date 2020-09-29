import { Stats, Report, Compilation, Compiler } from '../types';

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

export const mockReport = {
    timings: {
        tapables: {},
        loaders: {},
        modules: {},
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
