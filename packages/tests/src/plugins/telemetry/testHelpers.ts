// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/log';
import type { LogLevel, Options } from '@dd/core/types';
import type {
    Report,
    Compilation,
    OptionsDD,
    OptionsWithTelemetry,
    OutputOptions,
    TelemetryOptions,
    Module,
} from '@dd/telemetry-plugins/types';
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
    dependencies: {},
};

export const mockOptions: Options = {
    auth: {
        apiKey: '',
    },
};
export const mockLogger: Logger = jest.fn((text: any, type?: LogLevel) => {});
export const mockOutputOptions: OutputOptions = true;
export const mockOptionsDD: OptionsDD = {
    tags: [],
    prefix: '',
    timestamp: 1,
    filters: [],
};
export const mockTelemetryOptions: TelemetryOptions = {};
export const mockOptionsWithTelemetry: OptionsWithTelemetry = {
    ...mockOptions,
    telemetry: mockTelemetryOptions,
};
