// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getResolvedPath } from '@dd/core/helpers';
import type { GlobalContext, Options } from '@dd/core/types';
import { getSourcemapsConfiguration } from '@dd/tests/plugins/rum/testHelpers';
import { getTelemetryConfiguration } from '@dd/tests/plugins/telemetry/testHelpers';
import path from 'path';

if (!process.env.PROJECT_CWD) {
    throw new Error('Please update the usage of `process.env.PROJECT_CWD`.');
}
const ROOT = process.env.PROJECT_CWD!;

export const PROJECT_ROOT = path.join(ROOT, 'packages/tests/src/fixtures/project');
export const FAKE_URL = 'https://example.com';
export const API_PATH = '/v2/srcmap';
export const INTAKE_URL = `${FAKE_URL}${API_PATH}`;

export const defaultEntry = '@dd/tests/fixtures/main.js';
export const defaultDestination = path.resolve(PROJECT_ROOT, '../dist');

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
        start: Date.now(),
        version: 'FAKE_VERSION',
        ...options,
    };
};

export const getComplexBuildOverrides = (
    overrides: Record<string, any> = {},
): Record<string, any> => {
    // Add more entries with more dependencies.
    const entries = {
        app1: '@dd/tests/fixtures/project/main1.js',
        app2: '@dd/tests/fixtures/project/main2.js',
    };

    const bundlerOverrides = {
        rollup: {
            input: entries,
            ...overrides.rollup,
        },
        vite: {
            input: entries,
            ...overrides.vite,
        },
        esbuild: {
            entryPoints: entries,
            ...overrides.esbuild,
        },
        webpack5: { entry: entries, ...overrides.webpack5 },
        webpack4: {
            // Webpack 4 doesn't support pnp.
            entry: Object.fromEntries(
                Object.entries(entries).map(([name, filepath]) => [
                    name,
                    `./${path.relative(process.cwd(), getResolvedPath(filepath))}`,
                ]),
            ),
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
