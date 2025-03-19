// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getAbsolutePath } from '@dd/core/helpers/paths';
import type {
    BuildReport,
    File,
    GetPluginsOptions,
    GlobalContext,
    Logger,
    LogLevel,
    Options,
} from '@dd/core/types';
import { getSourcemapsConfiguration } from '@dd/tests/unit/plugins/error-tracking/testHelpers';
import { getTelemetryConfiguration } from '@dd/tests/unit/plugins/telemetry/testHelpers';
import { configXpack } from '@dd/tools/bundlers';
import type { PluginBuild } from 'esbuild';
import path from 'path';

import type { BundlerOptionsOverrides, BundlerOverrides } from './types';

export const FAKE_URL = 'https://example.com';
export const API_PATH = '/v2/srcmap';
export const INTAKE_URL = `${FAKE_URL}${API_PATH}`;

export const defaultEntry = './easy_project/main.js';
export const defaultEntries = {
    app1: './hard_project/main1.js',
    app2: './hard_project/main2.js',
};

export const defaultAuth = { apiKey: '123', appKey: '123' };
export const defaultPluginOptions: GetPluginsOptions = {
    auth: defaultAuth,
    disableGit: false,
    logLevel: 'debug',
};

export const mockLogFn = jest.fn((text: any, level: LogLevel) => {});
const logFn: Logger = {
    getLogger: jest.fn(),
    time: jest.fn(),
    error: (text: any) => {
        mockLogFn(text, 'error');
    },
    warn: (text: any) => {
        mockLogFn(text, 'warn');
    },
    info: (text: any) => {
        mockLogFn(text, 'info');
    },
    debug: (text: any) => {
        mockLogFn(text, 'debug');
    },
};
export const mockLogger: Logger = logFn;

export const getEsbuildMock = (overrides: Partial<PluginBuild> = {}): PluginBuild => {
    return {
        resolve: async (filepath) => {
            return {
                errors: [],
                warnings: [],
                external: false,
                sideEffects: false,
                namespace: '',
                suffix: '',
                pluginData: {},
                path: getAbsolutePath(process.cwd(), filepath),
            };
        },
        onStart: jest.fn(),
        onEnd: jest.fn(),
        onResolve: jest.fn(),
        onLoad: jest.fn(),
        onDispose: jest.fn(),
        ...overrides,
        esbuild: {
            context: jest.fn(),
            build: jest.fn(),
            buildSync: jest.fn(),
            transform: jest.fn(),
            transformSync: jest.fn(),
            formatMessages: jest.fn(),
            formatMessagesSync: jest.fn(),
            analyzeMetafile: jest.fn(),
            analyzeMetafileSync: jest.fn(),
            initialize: jest.fn(),
            version: '1.0.0',
            ...(overrides.esbuild || {}),
        },
        initialOptions: {
            ...(overrides.initialOptions || {}),
        },
    };
};

export const getMockBuild = (overrides: Partial<BuildReport> = {}): BuildReport => ({
    errors: [],
    warnings: [],
    logs: [],
    timings: [],
    ...overrides,
    bundler: {
        name: 'esbuild',
        fullName: 'esbuild',
        version: 'FAKE_VERSION',
        ...(overrides.bundler || {}),
    },
});

export const getContextMock = (overrides: Partial<GlobalContext> = {}): GlobalContext => {
    return {
        auth: defaultAuth,
        bundler: {
            ...getMockBuild().bundler,
            outDir: '/cwd/path',
        },
        build: getMockBuild(),
        cwd: '/cwd/path',
        env: 'test',
        getLogger: jest.fn(),
        asyncHook: jest.fn(),
        hook: jest.fn(),
        inject: jest.fn(),
        pluginNames: [],
        sendLog: jest.fn(),
        plugins: [],
        start: Date.now(),
        version: 'FAKE_VERSION',
        ...overrides,
    };
};

export const getComplexBuildOverrides =
    (overrides?: BundlerOverrides) =>
    (workingDir: string): Required<BundlerOverrides> => {
        const overridesResolved =
            typeof overrides === 'function' ? overrides(workingDir) : overrides || {};

        // Using a function to avoid mutation of the same object later down the line.
        const entries = () =>
            Object.fromEntries(
                Object.entries(defaultEntries).map(([key, value]) => [
                    key,
                    path.resolve(workingDir, value),
                ]),
            );

        const bundlerOverrides = {
            rollup: {
                input: entries(),
                ...overridesResolved.rollup,
            },
            vite: {
                input: entries(),
                ...overridesResolved.vite,
            },
            esbuild: {
                entryPoints: entries(),
                ...overridesResolved.esbuild,
            },
            rspack: { entry: entries(), ...overridesResolved.rspack },
            webpack5: { entry: entries(), ...overridesResolved.webpack5 },
            webpack4: { entry: entries(), ...overridesResolved.webpack4 },
        };

        return bundlerOverrides;
    };

// To get a node safe build.
export const getNodeSafeBuildOverrides = (
    workingDir: string,
    overrides?: BundlerOverrides,
): Required<BundlerOptionsOverrides> => {
    const overridesResolved =
        typeof overrides === 'function' ? overrides(workingDir) : overrides || {};
    // We don't care about the seed and the bundler name
    // as we won't use the output config here.
    const baseWebpack = configXpack({ workingDir: 'fake_cwd', outDir: 'dist', entry: {} });
    const bundlerOverrides: Required<BundlerOptionsOverrides> = {
        rollup: {
            ...overridesResolved.rollup,
            output: {
                ...overridesResolved.rollup?.output,
                format: 'cjs',
            },
        },
        vite: {
            ...overridesResolved.vite,
            output: {
                ...overridesResolved.vite?.output,
                format: 'cjs',
            },
        },
        esbuild: {
            ...overridesResolved.esbuild,
        },
        rspack: {
            target: 'node',
            optimization: {
                ...baseWebpack.optimization,
                splitChunks: false,
            },
            ...overridesResolved.rspack,
        },
        webpack5: {
            target: 'node',
            optimization: {
                ...baseWebpack.optimization,
                splitChunks: false,
            },
            ...overridesResolved.webpack5,
        },
        webpack4: {
            target: 'node',
            optimization: {
                ...baseWebpack.optimization,
                splitChunks: false,
            },
            ...overridesResolved.webpack4,
        },
    };

    return bundlerOverrides;
};

// Return a plugin configuration including all the features.
export const getFullPluginConfig = (overrides: Partial<Options> = {}): Options => {
    return {
        ...defaultPluginOptions,
        errorTracking: {
            sourcemaps: getSourcemapsConfiguration(),
        },
        rum: {
            sdk: {
                applicationId: '123',
                clientToken: '123',
            },
        },
        telemetry: getTelemetryConfiguration(),
        ...overrides,
    };
};

// Returns a JSON of files with their content.
// To be used with memfs' vol.fromJSON.
export const getMirroredFixtures = (paths: string[], cwd: string) => {
    const fsa = jest.requireActual('fs');
    const fixtures: Record<string, string> = {};
    for (const p of paths) {
        fixtures[p] = fsa.readFileSync(path.resolve(cwd, p), 'utf-8');
    }
    return fixtures;
};

// Filter out stuff from the build report.
export const filterOutParticularities = (input: File) =>
    // Vite injects its own preloader helper.
    !input.filepath.includes('vite/preload-helper') &&
    // Exclude ?commonjs-* files, which are coming from the rollup/vite commonjs plugin.
    !input.filepath.includes('?commonjs-') &&
    // Exclude webpack buildin modules, which are webpack internal dependencies.
    !input.filepath.includes('webpack4/buildin') &&
    // Exclude webpack's fake entry point.
    !input.filepath.includes('fixtures/empty.js');
