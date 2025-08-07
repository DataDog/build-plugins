// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { validateOptions } from './validate';

describe('validateOptions', () => {
    describe('enable', () => {
        const cases = [
            {
                description: 'return false when no output config provided',
                input: {},
                expected: false,
            },
            {
                description: 'return true when output config is an empty object',
                input: { output: {} },
                expected: true,
            },
            {
                description: 'return true when output config has enable: true',
                input: { output: { enable: true } },
                expected: true,
            },
            {
                description: 'return false when output config has enable: false',
                input: { output: { enable: false } },
                expected: false,
            },
        ];

        test.each(cases)('Should $description', ({ input, expected }) => {
            const result = validateOptions(input);
            expect(result.enable).toBe(expected);
        });
    });

    describe('path', () => {
        const cases = [
            {
                description: 'use default path when not provided',
                input: { output: {} },
                expected: './',
            },
            {
                description: 'use custom path when provided',
                input: { output: { path: './custom-reports' } },
                expected: './custom-reports',
            },
            {
                description: 'use absolute path when provided',
                input: { output: { path: '/absolute/path' } },
                expected: '/absolute/path',
            },
        ];

        test.each(cases)('Should $description', ({ input, expected }) => {
            const result = validateOptions(input);
            expect(result.path).toBe(expected);
        });
    });

    describe('files', () => {
        test('Should have all files enabled by default when files is undefined', () => {
            const result = validateOptions({ output: {} });
            expect(result.files).toEqual({
                build: 'build.json',
                bundler: 'bundler.json',
                dependencies: 'dependencies.json',
                errors: 'errors.json',
                logs: 'logs.json',
                metrics: 'metrics.json',
                timings: 'timings.json',
                warnings: 'warnings.json',
            });
        });

        test('Should have all files disabled by default when files is empty object', () => {
            const result = validateOptions({ output: { files: {} } });
            expect(result.files).toEqual({
                build: false,
                bundler: false,
                dependencies: false,
                errors: false,
                logs: false,
                metrics: false,
                timings: false,
                warnings: false,
            });
        });

        test('Should handle mixed file configuration', () => {
            const result = validateOptions({
                output: {
                    files: {
                        build: false,
                        timings: 'some-other-name-without-extension',
                        logs: './logs/some-name-with-extension.txt',
                        errors: 'error-log.json',
                        warnings: true,
                    },
                },
            });

            expect(result.files).toEqual({
                build: false,
                bundler: false,
                dependencies: false,
                errors: 'error-log.json',
                logs: './logs/some-name-with-extension.txt.json',
                metrics: false,
                timings: 'some-other-name-without-extension.json',
                warnings: 'warnings.json',
            });
        });
    });
});
