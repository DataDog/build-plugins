// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { resetEnableWarnings } from '@dd/core/helpers/options';
import type { Logger } from '@dd/core/types';

import { validateOptions } from './validate';

const mockLogger: Logger = {
    getLogger: jest.fn(() => mockLogger),
    time: jest.fn() as unknown as Logger['time'],
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
};

beforeEach(() => {
    jest.clearAllMocks();
    resetEnableWarnings();
});

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
            const result = validateOptions(input, mockLogger);
            expect(result.enable).toBe(expected);
        });
    });

    describe('enable deprecation warning for non-boolean values', () => {
        test('Should coerce enable: 1 to true and warn', () => {
            const result = validateOptions(
                { output: { enable: 1 } } as unknown as Parameters<typeof validateOptions>[0],
                mockLogger,
            );
            expect(result.enable).toBe(true);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('output.enable'));
        });

        test('Should coerce enable: 0 to false and warn', () => {
            const result = validateOptions(
                { output: { enable: 0 } } as unknown as Parameters<typeof validateOptions>[0],
                mockLogger,
            );
            expect(result.enable).toBe(false);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
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
            const result = validateOptions(input, mockLogger);
            expect(result.path).toBe(expected);
        });
    });

    describe('files', () => {
        test('Should have all files enabled by default when files is undefined', () => {
            const result = validateOptions({ output: {} }, mockLogger);
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
            const result = validateOptions({ output: { files: {} } }, mockLogger);
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
            const result = validateOptions(
                {
                    output: {
                        files: {
                            build: false,
                            timings: 'some-other-name-without-extension',
                            logs: './logs/some-name-with-extension.txt',
                            errors: 'error-log.json',
                            warnings: true,
                        },
                    },
                },
                mockLogger,
            );

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
