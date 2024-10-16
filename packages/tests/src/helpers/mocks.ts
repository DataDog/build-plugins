// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, Options } from '@dd/core/types';
import { getSourcemapsConfiguration } from '@dd/tests/plugins/rum/testHelpers';
import { getTelemetryConfiguration } from '@dd/tests/plugins/telemetry/testHelpers';
import path from 'path';
import type { Configuration as Configuration4 } from 'webpack4';

import { getBaseWebpackConfig, getWebpack4Entries } from './configBundlers';
import type { BundlerOverrides } from './types';

if (!process.env.PROJECT_CWD) {
    throw new Error('Please update the usage of `process.env.PROJECT_CWD`.');
}
const ROOT = process.env.PROJECT_CWD!;

export const FAKE_URL = 'https://example.com';
export const API_PATH = '/v2/srcmap';
export const INTAKE_URL = `${FAKE_URL}${API_PATH}`;

export const defaultEntry = '@dd/tests/fixtures/main.js';
export const defaultEntries = {
    app1: '@dd/tests/fixtures/project/main1.js',
    app2: '@dd/tests/fixtures/project/main2.js',
};
export const defaultDestination = path.resolve(ROOT, 'packages/tests/src/fixtures/dist');

export const defaultPluginOptions: Options = {
    auth: {
        apiKey: '123',
    },
    logLevel: 'debug',
};

export const getContextMock = (options: Partial<GlobalContext> = {}): GlobalContext => {
    return {
        auth: { apiKey: 'FAKE_API_KEY' },
        bundler: {
            name: 'FAKE_BUNDLER_NAME',
            fullName: 'FAKE_BUNDLER_FULLNAME',
            outDir: '/cwd/path',
        },
        build: {
            warnings: [],
            errors: [],
        },
        cwd: '/cwd/path',
        inject: jest.fn(),
        pluginNames: [],
        start: Date.now(),
        version: 'FAKE_VERSION',
        ...options,
    };
};

export const getComplexBuildOverrides = (overrides: BundlerOverrides = {}): BundlerOverrides => {
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
        webpack5: { entry: defaultEntries, ...overrides.webpack5 },
        webpack4: {
            entry: getWebpack4Entries(defaultEntries),
            ...overrides.webpack4,
        },
    };

    return bundlerOverrides;
};

// To get a node safe build.
export const getNodeSafeBuildOverrides = (overrides: BundlerOverrides = {}): BundlerOverrides => {
    // We don't care about the seed and the bundler name
    // as we won't use the output config here.
    const baseWebpack = getBaseWebpackConfig('fake_seed', 'fake_bundler');
    const bundlerOverrides: BundlerOverrides = {
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

export const getFullPluginConfig = (overrides: Partial<Options> = {}): Options => {
    return {
        ...defaultPluginOptions,
        rum: {
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
