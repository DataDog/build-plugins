// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    Report,
    Compilation,
    OptionsDD,
    OptionsWithTelemetry,
    OutputOptions,
    TelemetryOptions,
    Module,
} from '@dd/telemetry-plugin/types';
import { FAKE_URL, defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import type { PluginBuild, Metafile } from 'esbuild';
import esbuild from 'esbuild';

export const getMockBuild = (overrides: Partial<PluginBuild>): PluginBuild => {
    return {
        initialOptions: {},
        esbuild,
        resolve: jest.fn(),
        onStart: jest.fn(),
        onEnd: jest.fn(),
        onResolve: jest.fn(),
        onDispose: jest.fn(),
        onLoad: jest.fn(),
        ...overrides,
    };
};

const mockTapable = { tap: jest.fn() };
export const mockModule: Module = {
    name: 'module',
    userRequest: '',
    size: 123,
    loaders: [],
    chunks: [],
    _chunks: new Set(),
    dependencies: [],
};

export const getMockModule = (overrides: Partial<Module>): Module => ({
    ...mockModule,
    ...overrides,
});

export const mockCompilation: Compilation = {
    options: {
        context: '/default/context',
    },
    moduleGraph: {
        getIssuer: () => mockModule,
        getModule: () => mockModule,
        issuer: mockModule,
    },
    hooks: {
        buildModule: mockTapable,
        succeedModule: mockTapable,
        failedModule: mockTapable,
        afterOptimizeTree: mockTapable,
    },
};

export const getMockCompilation = (overrides: Partial<Compilation>): Compilation => ({
    options: {
        ...mockCompilation.options,
        ...overrides.options,
    },
    moduleGraph: {
        ...mockCompilation.moduleGraph!,
        ...overrides.moduleGraph!,
    },
    hooks: {
        ...mockCompilation.hooks,
        ...overrides.hooks,
    },
});

export const mockMetaFile: Metafile = {
    inputs: {
        module1: {
            bytes: 1,
            imports: [],
        },
        module2: {
            bytes: 1,
            imports: [],
        },
    },
    outputs: {
        module1: {
            imports: [],
            exports: [],
            inputs: { module2: { bytesInOutput: 0 } },
            bytes: 0,
        },
        module2: {
            imports: [],
            exports: [],
            inputs: { module1: { bytesInOutput: 0 } },
            bytes: 0,
        },
    },
};

export const mockReport: Report = {
    timings: {
        tapables: new Map(),
        loaders: new Map(),
        modules: new Map(),
    },
};

export const mockOutputOptions: OutputOptions = true;
export const mockOptionsDD: OptionsDD = {
    tags: [],
    prefix: '',
    timestamp: 1,
    filters: [],
};
export const mockTelemetryOptions: TelemetryOptions = {};
export const mockOptionsWithTelemetry: OptionsWithTelemetry = {
    ...defaultPluginOptions,
    telemetry: mockTelemetryOptions,
};

export const getTelemetryConfiguration = (
    overrides: Partial<TelemetryOptions> = {},
): TelemetryOptions => ({
    enableTracing: true,
    endPoint: FAKE_URL,
    output: true,
    prefix: 'prefix',
    tags: ['tag'],
    timestamp: new Date().getTime(),
    ...overrides,
});
