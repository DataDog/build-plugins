// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { OptionsWithDefaults } from '@dd/core/types';
import { defaultPluginOptions, getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';

import type { LogsOptionsWithDefaults } from './types';
import { validateOptions } from './validate';

describe('validateOptions', () => {
    beforeEach(() => {
        mockLogFn.mockClear();
    });

    const disabledConfig: LogsOptionsWithDefaults = {
        enable: false,
        service: 'build-plugins',
        tags: [],
        logLevel: 'debug',
        includeBundlerLogs: true,
        includePluginLogs: true,
        includeModuleEvents: false,
        batchSize: 100,
        includeTimings: false,
    };

    const enabledDefaults: LogsOptionsWithDefaults = {
        enable: true,
        service: 'build-plugins',
        tags: [],
        logLevel: 'debug',
        includeBundlerLogs: true,
        includePluginLogs: true,
        includeModuleEvents: false,
        batchSize: 100,
        includeTimings: false,
    };

    const cases = [
        {
            description: 'return disabled when no logs config',
            options: {},
            expected: disabledConfig,
        },
        {
            description: 'return disabled when enable is false',
            options: { logs: { enable: false } },
            expected: disabledConfig,
        },
        {
            description: 'apply all defaults when logs config is present',
            options: { logs: {} },
            expected: enabledDefaults,
        },
        {
            description: 'apply all defaults when enable is true',
            options: { logs: { enable: true } },
            expected: enabledDefaults,
        },
        {
            description: 'respect custom service name',
            options: { logs: { service: 'my-service' } },
            expected: { ...enabledDefaults, service: 'my-service' },
        },
        {
            description: 'respect custom tags',
            options: { logs: { tags: ['env:prod', 'team:frontend'] } },
            expected: { ...enabledDefaults, tags: ['env:prod', 'team:frontend'] },
        },
        {
            description: 'respect custom logLevel',
            options: { logs: { logLevel: 'warn' as const } },
            expected: { ...enabledDefaults, logLevel: 'warn' as const },
        },
        {
            description: 'respect includeBundlerLogs set to false',
            options: { logs: { includeBundlerLogs: false } },
            expected: { ...enabledDefaults, includeBundlerLogs: false },
        },
        {
            description: 'respect includePluginLogs set to false',
            options: { logs: { includePluginLogs: false } },
            expected: { ...enabledDefaults, includePluginLogs: false },
        },
        {
            description: 'respect includeModuleEvents set to true',
            options: { logs: { includeModuleEvents: true } },
            expected: { ...enabledDefaults, includeModuleEvents: true },
        },
        {
            description: 'respect custom batchSize',
            options: { logs: { batchSize: 50 } },
            expected: { ...enabledDefaults, batchSize: 50 },
        },
        {
            description: 'respect includeTimings set to true',
            options: { logs: { includeTimings: true } },
            expected: { ...enabledDefaults, includeTimings: true },
        },
        {
            description: 'include env when provided',
            options: { logs: { env: 'production' } },
            expected: { ...enabledDefaults, env: 'production' },
        },
        {
            description: 'handle all custom options together',
            options: {
                logs: {
                    service: 'my-app',
                    env: 'staging',
                    tags: ['version:1.0.0'],
                    logLevel: 'info' as const,
                    includeBundlerLogs: false,
                    includePluginLogs: false,
                    includeModuleEvents: true,
                    batchSize: 25,
                    includeTimings: true,
                },
            },
            expected: {
                enable: true,
                service: 'my-app',
                env: 'staging',
                tags: ['version:1.0.0'],
                logLevel: 'info' as const,
                includeBundlerLogs: false,
                includePluginLogs: false,
                includeModuleEvents: true,
                batchSize: 25,
                includeTimings: true,
            },
        },
    ];

    test.each(cases)('Should $description', ({ options, expected }) => {
        const mockLogger = getMockLogger();
        const fullOptions: OptionsWithDefaults = {
            ...defaultPluginOptions,
            ...options,
        };

        const result = validateOptions(fullOptions, mockLogger);
        expect(result).toEqual(expected);
    });

    describe('API key validation', () => {
        test('Should throw when no API key is present', () => {
            const mockLogger = getMockLogger();
            const options: OptionsWithDefaults = {
                ...defaultPluginOptions,
                auth: { apiKey: '', site: 'example.com' },
                logs: {},
            };

            expect(() => validateOptions(options, mockLogger)).toThrow(
                'Invalid configuration for datadog-logs-plugin.',
            );
        });

        test('Should throw when API key is undefined', () => {
            const mockLogger = getMockLogger();
            const options: OptionsWithDefaults = {
                ...defaultPluginOptions,
                auth: { apiKey: undefined as unknown as string, site: 'example.com' },
                logs: {},
            };

            expect(() => validateOptions(options, mockLogger)).toThrow(
                'Invalid configuration for datadog-logs-plugin.',
            );
        });

        test('Should not throw when API key is present', () => {
            const mockLogger = getMockLogger();
            const options: OptionsWithDefaults = {
                ...defaultPluginOptions,
                auth: { apiKey: 'valid-api-key', site: 'example.com' },
                logs: {},
            };

            expect(() => validateOptions(options, mockLogger)).not.toThrow();
        });
    });

    describe('debug logging', () => {
        test('Should log debug message with final options when enabled', () => {
            const mockLogger = getMockLogger();
            const options: OptionsWithDefaults = {
                ...defaultPluginOptions,
                logs: { service: 'test-service' },
            };

            validateOptions(options, mockLogger);

            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('datadog-logs-plugin options:'),
                'debug',
            );
        });

        test('Should not log debug message when disabled', () => {
            const mockLogger = getMockLogger();
            const options: OptionsWithDefaults = {
                ...defaultPluginOptions,
                logs: { enable: false },
            };

            validateOptions(options, mockLogger);

            expect(mockLogFn).not.toHaveBeenCalledWith(
                expect.stringContaining('datadog-logs-plugin options:'),
                'debug',
            );
        });
    });
});
