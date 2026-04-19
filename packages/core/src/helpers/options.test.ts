// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';

import { resetEnableWarnings, resolveEnable, validateEnableStrict } from './options';

const mockLogger: Logger = {
    getLogger: jest.fn(),
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

describe('resolveEnable', () => {
    describe('standard boolean / omitted values', () => {
        const cases = [
            {
                description: 'return false when the config key is undefined',
                options: {},
                expected: false,
            },
            {
                description: 'return false when the config key is null',
                options: { myPlugin: null },
                expected: false,
            },
            {
                description: 'return true when the config key is a truthy object without enable',
                options: { myPlugin: { someOther: 'val' } },
                expected: true,
            },
            {
                description: 'return true when enable is true',
                options: { myPlugin: { enable: true } },
                expected: true,
            },
            {
                description: 'return false when enable is false',
                options: { myPlugin: { enable: false } },
                expected: false,
            },
            {
                description: 'return true when enable is undefined (object present)',
                options: { myPlugin: { enable: undefined } },
                expected: true,
            },
        ];

        test.each(cases)('should $description', ({ options, expected }) => {
            expect(resolveEnable(options, 'myPlugin', mockLogger)).toBe(expected);
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });
    });

    describe('non-boolean coercion with deprecation warning', () => {
        const cases = [
            {
                description: 'coerce enable: 1 to true and warn',
                options: { myPlugin: { enable: 1 } },
                expected: true,
            },
            {
                description: 'coerce enable: 0 to false and warn',
                options: { myPlugin: { enable: 0 } },
                expected: false,
            },
            {
                description: 'coerce enable: "true" to true and warn',
                options: { myPlugin: { enable: 'true' } },
                expected: true,
            },
            {
                description: 'coerce enable: "" to false and warn',
                options: { myPlugin: { enable: '' } },
                expected: false,
            },
        ];

        test.each(cases)('should $description', ({ options, expected }) => {
            expect(resolveEnable(options, 'myPlugin', mockLogger)).toBe(expected);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('myPlugin.enable'),
            );
        });
    });

    describe('warn-once behavior', () => {
        test('should only warn once per config key across multiple calls', () => {
            resolveEnable({ myPlugin: { enable: 1 } }, 'myPlugin', mockLogger);
            resolveEnable({ myPlugin: { enable: 'yes' } }, 'myPlugin', mockLogger);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        });

        test('should warn separately for different config keys', () => {
            resolveEnable({ pluginA: { enable: 1 } }, 'pluginA', mockLogger);
            resolveEnable({ pluginB: { enable: 1 } }, 'pluginB', mockLogger);
            expect(mockLogger.warn).toHaveBeenCalledTimes(2);
        });
    });
});

describe('validateEnableStrict', () => {
    test('should not push an error when enable is a boolean', () => {
        const errors: string[] = [];
        validateEnableStrict({ enable: true }, errors);
        expect(errors).toHaveLength(0);
    });

    test('should not push an error when enable is undefined', () => {
        const errors: string[] = [];
        validateEnableStrict({ enable: undefined }, errors);
        expect(errors).toHaveLength(0);
    });

    test('should push an error when enable is a non-boolean', () => {
        const errors: string[] = [];
        validateEnableStrict({ enable: 'yes' }, errors);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('enable');
        expect(errors[0]).toContain('boolean');
    });
});
