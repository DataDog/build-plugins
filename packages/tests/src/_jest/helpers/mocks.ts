// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    checkFile,
    getFile,
    readFileSync,
    readFile,
    existsSync,
    outputFileSync,
} from '@dd/core/helpers/fs';
import { getAbsolutePath } from '@dd/core/helpers/paths';
import { getUniqueId } from '@dd/core/helpers/strings';
import type {
    BuildReport,
    FileReport,
    GetPluginsArg,
    GetPluginsOptions,
    GlobalContext,
    GlobalData,
    GlobalStores,
    Logger,
    LogLevel,
    Options,
    RepositoryData,
    TimeLogger,
} from '@dd/core/types';
import type {
    Metadata,
    MultipartValue,
    Payload,
} from '@dd/error-tracking-plugin/sourcemaps/payload';
import type {
    SourcemapsOptions,
    SourcemapsOptionsWithDefaults,
    Sourcemap,
} from '@dd/error-tracking-plugin/types';
import { TrackedFilesMatcher } from '@dd/internal-git-plugin/trackedFilesMatcher';
import type {
    Report,
    Compilation,
    OptionsDD,
    TelemetryOptions,
    Module,
} from '@dd/telemetry-plugin/types';
import { configXpack } from '@dd/tools/bundlers';
import { File } from 'buffer';
import type { PluginBuild, Metafile } from 'esbuild';
import esbuild from 'esbuild';
import type { PathLike, Stats } from 'fs';
import path from 'path';

import { getTempWorkingDir } from './env';
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
    metadata: {},
};

export const getMockBundler = (
    overrides: Partial<BuildReport['bundler']> = {},
): BuildReport['bundler'] => ({
    name: 'esbuild',
    fullName: 'esbuild',
    variant: '',
    version: 'FAKE_VERSION',
    ...overrides,
});

export const getMockData = (overrides: Partial<GlobalData> = {}): GlobalData => ({
    env: 'test',
    metadata: {},
    bundler: getMockBundler(overrides.bundler),
    packageName: '@datadog/esbuild-plugin',
    version: 'FAKE_VERSION',
    ...overrides,
});

export const getMockStores = (overrides: Partial<GlobalStores> = {}): GlobalStores => ({
    logs: [],
    errors: [],
    warnings: [],
    queue: [],
    timings: [],
    ...overrides,
});

export const getMockTimer = (
    overrides: Partial<TimeLogger['timer']> = {},
): TimeLogger['timer'] => ({
    pluginName: 'mock-plugin',
    label: 'mock-label',
    spans: [],
    tags: [],
    logLevel: 'debug',
    total: 0,
    ...overrides,
});

export const getMockTimeLogger = (overrides: Partial<TimeLogger> = {}): TimeLogger => {
    const mockTimer: TimeLogger = {
        end: jest.fn(),
        resume: jest.fn(),
        pause: jest.fn(),
        tag: jest.fn(),
        ...overrides,
        timer: getMockTimer(overrides.timer),
    };

    return mockTimer;
};

export const mockLogFn = jest.fn((text: any, level: LogLevel) => {});
export const getMockLogger = (overrides: Partial<Logger> = {}): Logger => ({
    getLogger: jest.fn(),
    time: jest.fn(() => getMockTimeLogger()),
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
    ...overrides,
});
export const mockLogger: Logger = getMockLogger();

export const getEsbuildMock = (
    overrides: Partial<PluginBuild> = {},
    cwd: string = process.cwd(),
): PluginBuild => {
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
                path: getAbsolutePath(cwd, filepath),
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

export const getMockBuildReport = (overrides: Partial<BuildReport> = {}): BuildReport => ({
    errors: [],
    warnings: [],
    metadata: {},
    logs: [],
    timings: [],
    ...overrides,
    bundler: getMockBundler(overrides.bundler),
});

export const getGetPluginsArg = (
    optionsOverrides: Partial<Options> = {},
    contextOverrides: Partial<GlobalContext> = {},
): GetPluginsArg => {
    return {
        options: optionsOverrides,
        context: getContextMock(contextOverrides),
        data: getMockData(),
        stores: getMockStores(),
        bundler: {},
    };
};

export const getContextMock = (overrides: Partial<GlobalContext> = {}): GlobalContext => {
    return {
        auth: defaultAuth,
        bundler: {
            ...getMockBundler(overrides.bundler),
            outDir: '/cwd/path',
        },
        build: getMockBuildReport(),
        cwd: '/cwd/path',
        env: 'test',
        getLogger: jest.fn(() => getMockLogger()),
        asyncHook: jest.fn(),
        hook: jest.fn(),
        inject: jest.fn(),
        pluginNames: [],
        sendLog: jest.fn(),
        plugins: [],
        queue: jest.fn(),
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
            privacy: {
                disabled: false,
            },
        },
        telemetry: getTelemetryConfiguration(),
        ...overrides,
    };
};

// Filter out stuff from the build report.
export const filterOutParticularities = (input: FileReport) =>
    // Vite injects its own preloader helper.
    !input.filepath.includes('vite/preload-helper') &&
    // Exclude ?commonjs-* files, which are coming from the rollup/vite commonjs plugin.
    !input.filepath.includes('?commonjs-') &&
    // Exclude webpack buildin modules, which are webpack internal dependencies.
    !input.filepath.includes('webpack4/buildin') &&
    // Exclude webpack's fake entry point.
    !input.filepath.includes('fixtures/empty.js');

export const getMockPluginBuild = (overrides: Partial<PluginBuild>): PluginBuild => {
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

export const mockOptionsDD: OptionsDD = {
    tags: [],
    prefix: '',
    timestamp: 1,
    filters: [],
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

export const getMinimalSourcemapsConfiguration = (
    options: Partial<SourcemapsOptions> = {},
): SourcemapsOptions => {
    return {
        minifiedPathPrefix: '/prefix',
        releaseVersion: '1.0.0',
        service: 'error-tracking-build-plugin-sourcemaps',
        ...options,
    };
};

export const getSourcemapsConfiguration = (
    options: Partial<SourcemapsOptions> = {},
): SourcemapsOptionsWithDefaults => {
    return {
        bailOnError: false,
        disableGit: false,
        dryRun: false,
        maxConcurrency: 10,
        intakeUrl: INTAKE_URL,
        minifiedPathPrefix: '/prefix',
        releaseVersion: '1.0.0',
        service: 'error-tracking-build-plugin-sourcemaps',
        ...options,
    };
};

export const getSourcemapMock = (options: Partial<Sourcemap> = {}): Sourcemap => {
    return {
        minifiedFilePath: '/path/to/minified.min.js',
        minifiedPathPrefix: '/prefix',
        minifiedUrl: '/prefix/path/to/minified.js',
        relativePath: 'path/to/minified.min.js',
        sourcemapFilePath: '/path/to/sourcemap.js.map',
        ...options,
    };
};

export const getMetadataMock = (options: Partial<Metadata> = {}): Metadata => {
    return {
        plugin_version: '1.0.0',
        project_path: '/path/to/project',
        service: 'error-tracking-build-plugin-sourcemaps',
        type: 'js_sourcemap',
        version: '1.0.0',
        ...options,
    };
};

export const getRepositoryDataMock = (options: Partial<RepositoryData> = {}): RepositoryData => {
    return {
        commit: {
            hash: 'hash',
            message: 'message',
            author: {
                name: 'author',
                email: 'author@example.com',
                date: '2021-01-01',
            },
            committer: {
                name: 'committer',
                email: 'committer@example.com',
                date: '2021-01-01',
            },
        },
        hash: 'hash',
        branch: 'branch',
        remote: 'remote',
        trackedFilesMatcher: new TrackedFilesMatcher(['/path/to/minified.min.js']),
        ...options,
    };
};

export const getPayloadMock = (
    options: Partial<Payload> = {},
    content: [string, MultipartValue][] = [],
): Payload => {
    return {
        content: new Map<string, MultipartValue>([
            [
                'source_map',
                {
                    type: 'file',
                    path: '/path/to/sourcemap.js.map',
                    options: { filename: 'source_map', contentType: 'application/json' },
                },
            ],
            [
                'minified_file',
                {
                    type: 'file',
                    path: '/path/to/minified.min.js',
                    options: {
                        filename: 'minified_file',
                        contentType: 'application/javascript',
                    },
                },
            ],
            ...content,
        ]),
        errors: [],
        warnings: [],
        ...options,
    };
};

// Mocking files in fs.
const mockGetFile = jest.mocked(getFile);
const mockCheckFile = jest.mocked(checkFile);
const mockReadFileSync = jest.mocked(readFileSync);
const mockReadFile = jest.mocked(readFile);
const mockExistsSync = jest.mocked(existsSync);
const mockStat = jest.mocked(require('fs/promises').stat);
const mockGlobSync = jest.mocked(require('glob').glob.sync);

export const addFixtureFiles = (files: Record<string, string>, cwd: string = __dirname) => {
    let toReturnCwd = cwd;
    const getENOENTError = () => {
        const err = new Error(`File not found`);
        (err as any).code = 'ENOENT';
        return err;
    };

    // Convert relative paths to absolute paths based on the provided cwd.
    const absoluteFiles: Record<string, string> = {};
    for (const [relativePath, content] of Object.entries(files)) {
        const absolutePath = path.resolve(cwd, relativePath);
        absoluteFiles[absolutePath] = content;
    }

    // Default readFile mock
    const readFileImplementation = (filePath: string) => {
        const resolvedPath = path.resolve(cwd, filePath);
        if (absoluteFiles[resolvedPath] === undefined) {
            throw getENOENTError();
        }
        return absoluteFiles[resolvedPath] || '';
    };

    if (typeof mockCheckFile.mockImplementation === 'function') {
        mockCheckFile.mockImplementation(async (filePath) => {
            const resolvedPath = path.resolve(cwd, filePath);
            return {
                empty: !absoluteFiles[resolvedPath],
                exists: !!absoluteFiles[resolvedPath],
            };
        });
    }
    if (typeof mockGetFile.mockImplementation === 'function') {
        mockGetFile.mockImplementation(async (filePath, options) => {
            const resolvedPath = path.resolve(cwd, filePath);
            if (absoluteFiles[resolvedPath] === undefined) {
                throw getENOENTError();
            }
            const filecontent = new Blob([absoluteFiles[resolvedPath] || '']);
            return new File([filecontent], options.filename, { type: options.contentType });
        });
    }
    if (typeof mockReadFileSync.mockImplementation === 'function') {
        mockReadFileSync.mockImplementation(readFileImplementation);
    }
    if (typeof mockReadFile.mockImplementation === 'function') {
        mockReadFile.mockImplementation(async (filePath: string) =>
            readFileImplementation(filePath),
        );
    }
    if (typeof mockStat.mockImplementation === 'function') {
        mockStat.mockImplementation(async (filePath: PathLike) => {
            const resolvedPath = path.resolve(cwd, filePath.toString());
            if (absoluteFiles[resolvedPath] === undefined) {
                throw getENOENTError();
            }
            return {
                size: absoluteFiles[resolvedPath].length,
            } as Stats;
        });
    }
    if (typeof mockExistsSync.mockImplementation === 'function') {
        mockExistsSync.mockImplementation((filePath: string) => {
            const resolvedPath = path.resolve(cwd, filePath);
            return absoluteFiles[resolvedPath] !== undefined;
        });
    }
    if (typeof mockGlobSync.mockImplementation === 'function') {
        // Create a temp directory to store the files we want to fixture.
        const seed: string = `${Math.abs(jest.getSeed())}.${getUniqueId()}`;
        const workingDir = getTempWorkingDir(seed);
        toReturnCwd = workingDir;

        // Create the files in the temp directory.
        for (const [relativePath, content] of Object.entries(files)) {
            const absolutePath = path.resolve(workingDir, relativePath);
            outputFileSync(absolutePath, content);
        }

        mockGlobSync.mockImplementation((pattern: string) => {
            const original = jest.requireActual('glob');
            // Re-orient glob to the temp directory.
            return original.glob.sync(pattern, {
                cwd: workingDir,
            });
        });
    }

    return toReturnCwd;
};
