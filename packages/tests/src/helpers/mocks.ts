// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, Options } from '@dd/core/types';
import path from 'path';

if (!process.env.PROJECT_CWD) {
    throw new Error('Please update the usage of `process.env.PROJECT_CWD`.');
}
const ROOT = process.env.PROJECT_CWD!;

export const PROJECT_ROOT = path.join(ROOT, 'packages/tests/src/fixtures/project');

export const defaultEntry = '@dd/tests/fixtures/index.js';
export const defaultDestination = path.resolve(PROJECT_ROOT, '../dist');

export const defaultPluginOptions: Options = {
    auth: {
        apiKey: '123',
    },
    logLevel: 'debug',
};

export const getContextMock = (options: Partial<GlobalContext> = {}): GlobalContext => {
    return {
        auth: { apiKey: '123' },
        cwd: '/cwd/path',
        version: '1.2.3',
        bundler: { name: 'esbuild', fullName: 'esbuild', outDir: '/cwd/path' },
        build: {
            warnings: [],
            errors: [],
        },
        start: Date.now(),
        ...options,
    };
};
