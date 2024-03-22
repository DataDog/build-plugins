// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

module.exports = {
    // Automatically clear mock calls and instances between every test
    clearMocks: true,
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/*.test.*'],
    globals: {
        'ts-jest': {
            tsConfig: 'tsconfig.json',
            packageJson: 'package.json',
        },
    },
    roots: ['./'],
};
