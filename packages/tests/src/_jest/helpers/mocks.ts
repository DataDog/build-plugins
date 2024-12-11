// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputJsonSync } from '@dd/core/helpers';
import type {
    File,
    GetCustomPlugins,
    GetPluginsOptions,
    GlobalContext,
    IterableElement,
    Logger,
    LogLevel,
    Options,
} from '@dd/core/types';
import { getAbsolutePath, serializeBuildReport } from '@dd/internal-build-report-plugin/helpers';
import { getSourcemapsConfiguration } from '@dd/tests/plugins/error-tracking/testHelpers';
import { getTelemetryConfiguration } from '@dd/tests/plugins/telemetry/testHelpers';
import type { PluginBuild } from 'esbuild';
import path from 'path';
import type { Configuration as Configuration4 } from 'webpack4';

import type { BundlerOverrides } from './types';
import { getBaseXpackConfig, getWebpack4Entries } from './xpackConfigs';

if (!process.env.PROJECT_CWD) {
    throw new Error('Please update the usage of `process.env.PROJECT_CWD`.');
}
const ROOT = process.env.PROJECT_CWD!;

export const FAKE_URL = 'https://example.com';
export const API_PATH = '/v2/srcmap';
export const INTAKE_URL = `${FAKE_URL}${API_PATH}`;

export const defaultEntry = '@dd/tests/_jest/fixtures/easy_project/main.js';
export const defaultEntries = {
    app1: '@dd/tests/_jest/fixtures/hard_project/main1.js',
    app2: '@dd/tests/_jest/fixtures/hard_project/main2.js',
};
export const defaultDestination = path.resolve(ROOT, 'packages/tests/src/_jest/fixtures/dist');
export const defaultAuth = { apiKey: '123', appKey: '123' };
export const defaultPluginOptions: GetPluginsOptions = {
    auth: defaultAuth,
    devServer: false,
    disableGit: false,
    logLevel: 'debug',
};

export const mockLogFn = jest.fn((text: any, level: LogLevel) => {});
const logFn: Logger = {
    getLogger: jest.fn(),
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

export const getEsbuildMock = (options: Partial<PluginBuild> = {}): PluginBuild => {
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
        ...options,
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
            ...(options.esbuild || {}),
        },
        initialOptions: {
            ...(options.initialOptions || {}),
        },
    };
};

export const getContextMock = (options: Partial<GlobalContext> = {}): GlobalContext => {
    return {
        auth: defaultAuth,
        bundler: {
            name: 'esbuild',
            fullName: 'esbuild',
            outDir: '/cwd/path',
            version: 'FAKE_VERSION',
        },
        build: {
            warnings: [],
            errors: [],
            logs: [],
        },
        cwd: '/cwd/path',
        inject: jest.fn(),
        pluginNames: [],
        start: Date.now(),
        version: 'FAKE_VERSION',
        ...options,
    };
};

export const getComplexBuildOverrides = (
    overrides: BundlerOverrides = {},
): Required<BundlerOverrides> => {
    const bundlerOverrides = {
        rollup: {
            input: defaultEntries,
            ...overrides.rollup,
        },
        vite: {
            input: defaultEntries,
            ...overrides.vite,
        },
        esbuild: {
            entryPoints: defaultEntries,
            ...overrides.esbuild,
        },
        rspack: { entry: defaultEntries, ...overrides.rspack },
        webpack5: { entry: defaultEntries, ...overrides.webpack5 },
        webpack4: {
            entry: getWebpack4Entries(defaultEntries),
            ...overrides.webpack4,
        },
    };

    return bundlerOverrides;
};

// To get a node safe build.
export const getNodeSafeBuildOverrides = (
    overrides: BundlerOverrides = {},
): Required<BundlerOverrides> => {
    // We don't care about the seed and the bundler name
    // as we won't use the output config here.
    const baseWebpack = getBaseXpackConfig('fake_seed', 'fake_bundler');
    const bundlerOverrides: Required<BundlerOverrides> = {
        rollup: {
            output: {
                format: 'cjs',
            },
            ...overrides.rollup,
        },
        vite: {
            output: {
                format: 'cjs',
            },
            ...overrides.vite,
        },
        esbuild: {
            ...overrides.esbuild,
        },
        rspack: {
            target: 'node',
            optimization: {
                ...baseWebpack.optimization,
                splitChunks: false,
            },
            ...overrides.rspack,
        },
        webpack5: {
            target: 'node',
            optimization: {
                ...baseWebpack.optimization,
                splitChunks: false,
            },
            ...overrides.webpack5,
        },
        webpack4: {
            target: 'node',
            optimization: {
                ...(baseWebpack.optimization as Configuration4['optimization']),
                splitChunks: false,
            },
            ...overrides.webpack4,
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

// Returns a customPlugin to output some debug files.
type CustomPlugins = ReturnType<GetCustomPlugins>;
export const debugFilesPlugins = (context: GlobalContext): CustomPlugins => {
    const rollupPlugin: IterableElement<CustomPlugins>['rollup'] = {
        writeBundle(options, bundle) {
            outputJsonSync(
                path.resolve(context.bundler.outDir, `output.${context.bundler.fullName}.json`),
                bundle,
            );
        },
    };

    const xpackPlugin: IterableElement<CustomPlugins>['webpack'] &
        IterableElement<CustomPlugins>['rspack'] = (compiler) => {
        type Compilation = Parameters<Parameters<typeof compiler.hooks.afterEmit.tap>[1]>[0];

        compiler.hooks.afterEmit.tap('bundler-outputs', (compilation: Compilation) => {
            const stats = compilation.getStats().toJson({
                all: false,
                assets: true,
                children: true,
                chunks: true,
                chunkGroupAuxiliary: true,
                chunkGroupChildren: true,
                chunkGroups: true,
                chunkModules: true,
                chunkRelations: true,
                entrypoints: true,
                errors: true,
                ids: true,
                modules: true,
                nestedModules: true,
                reasons: true,
                relatedAssets: true,
                warnings: true,
            });
            outputJsonSync(
                path.resolve(context.bundler.outDir, `output.${context.bundler.fullName}.json`),
                stats,
            );
        });
    };

    return [
        {
            name: 'build-report',
            writeBundle() {
                outputJsonSync(
                    path.resolve(context.bundler.outDir, `report.${context.bundler.fullName}.json`),
                    serializeBuildReport(context.build),
                );
            },
        },
        {
            name: 'bundler-outputs',
            esbuild: {
                setup(build) {
                    build.onEnd((result) => {
                        outputJsonSync(
                            path.resolve(
                                context.bundler.outDir,
                                `output.${context.bundler.fullName}.json`,
                            ),
                            result.metafile,
                        );
                    });
                },
            },
            rspack: xpackPlugin,
            rollup: rollupPlugin,
            vite: rollupPlugin,
            webpack: xpackPlugin,
        },
    ];
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
