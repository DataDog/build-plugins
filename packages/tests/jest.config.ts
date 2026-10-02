// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createJsWithTsPreset, type JestConfigWithTsJest } from 'ts-jest';

const presetConfig = createJsWithTsPreset();

const config: JestConfigWithTsJest = {
    ...presetConfig,
    // Automatically clear mock calls and instances between every test
    clearMocks: true,
    globalSetup: '<rootDir>/src/_jest/globalSetup.ts',
    roots: ['<rootDir>/../'],
    // @rspack/core v2 is pure ESM; use a custom resolver to load it via a .cjs shim
    // so Jest's CJS mode can require() it without triggering ERR_REQUIRE_ESM.
    resolver: '<rootDir>/src/_jest/rspack-jest-resolver.cjs',
    setupFilesAfterEnv: ['<rootDir>/src/_jest/setupAfterEnv.ts'],
    testEnvironment: 'node',
    testMatch: ['**/*.test.*'],
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    testTimeout: 10000,
};

export default config;
