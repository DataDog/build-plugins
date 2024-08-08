// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

module.exports = {
    // Automatically clear mock calls and instances between every test
    clearMocks: true,
    // Without it, vite import is silently crashing the process with code SIGHUP 129
    resetModules: true,
    preset: 'ts-jest/presets/js-with-ts',
    reporters: [['default', { summaryThreshold: 0 }]],
    testEnvironment: 'node',
    testMatch: ['**/*.test.*'],
    roots: ['./src/'],
};
