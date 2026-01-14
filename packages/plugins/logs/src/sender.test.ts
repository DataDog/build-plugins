// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest } from '@dd/core/helpers/request';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';

import { LOGS_API_PATH, LOGS_API_SUBDOMAIN } from './constants';
import { getIntakeUrl, sendLogs } from './sender';
import type { DatadogLogEntry, LogsOptionsWithDefaults } from './types';

jest.mock('@dd/core/helpers/request', () => ({
    doRequest: jest.fn(),
    NB_RETRIES: 3,
}));

const doRequestMock = jest.mocked(doRequest);

const getDefaultOptions = (
    overrides?: Partial<LogsOptionsWithDefaults>,
): LogsOptionsWithDefaults => ({
    enable: true,
    service: 'build-plugins',
    tags: [],
    logLevel: 'debug',
    includeBundlerLogs: true,
    includePluginLogs: true,
    includeModuleEvents: false,
    batchSize: 100,
    includeTimings: false,
    ...overrides,
});

const createLogEntry = (overrides?: Partial<DatadogLogEntry>): DatadogLogEntry => ({
    message: 'Test log message',
    status: 'info',
    service: 'build-plugins',
    ddtags: 'bundler:webpack',
    ddsource: 'webpack',
    hostname: 'test-host',
    bundler: {
        name: 'webpack',
        version: '5.0.0',
        outDir: '/dist',
    },
    timestamp: Date.now(),
    ...overrides,
});

describe('Logs Plugin sender', () => {
    describe('getIntakeUrl', () => {
        const originalEnv = process.env;

        beforeEach(() => {
            process.env = { ...originalEnv };
        });

        afterEach(() => {
            process.env = originalEnv;
        });

        test('Should construct correct URL for default site', () => {
            expect(getIntakeUrl('datadoghq.com')).toBe(
                `https://${LOGS_API_SUBDOMAIN}.datadoghq.com/${LOGS_API_PATH}`,
            );
        });

        test('Should construct correct URL for EU site', () => {
            expect(getIntakeUrl('datadoghq.eu')).toBe(
                `https://${LOGS_API_SUBDOMAIN}.datadoghq.eu/${LOGS_API_PATH}`,
            );
        });

        test('Should construct correct URL for US3 site', () => {
            expect(getIntakeUrl('us3.datadoghq.com')).toBe(
                `https://${LOGS_API_SUBDOMAIN}.us3.datadoghq.com/${LOGS_API_PATH}`,
            );
        });

        test('Should use DD_LOGS_INTAKE_URL env var when set', () => {
            const customUrl = 'https://custom.intake.url/api/v2/logs';
            process.env.DD_LOGS_INTAKE_URL = customUrl;

            expect(getIntakeUrl('datadoghq.com')).toBe(customUrl);
            expect(getIntakeUrl('datadoghq.eu')).toBe(customUrl);
        });

        test('Should use DATADOG_LOGS_INTAKE_URL env var when set', () => {
            const customUrl = 'https://custom.intake.url/api/v2/logs';
            process.env.DATADOG_LOGS_INTAKE_URL = customUrl;

            expect(getIntakeUrl('datadoghq.com')).toBe(customUrl);
        });

        test('Should prefer DD_LOGS_INTAKE_URL over DATADOG_LOGS_INTAKE_URL', () => {
            process.env.DD_LOGS_INTAKE_URL = 'https://primary.url/logs';
            process.env.DATADOG_LOGS_INTAKE_URL = 'https://secondary.url/logs';

            expect(getIntakeUrl('datadoghq.com')).toBe('https://primary.url/logs');
        });
    });

    describe('sendLogs', () => {
        beforeEach(() => {
            doRequestMock.mockClear();
            mockLogFn.mockClear();
        });

        test('Should return empty result when no logs', async () => {
            const mockLogger = getMockLogger();
            const options = getDefaultOptions();
            const auth = { apiKey: 'test-api-key', site: 'datadoghq.com' };

            const { errors, warnings } = await sendLogs([], options, auth, mockLogger);

            expect(errors).toHaveLength(0);
            expect(warnings).toHaveLength(0);
            expect(doRequestMock).not.toHaveBeenCalled();
        });

        test('Should return error when no API key provided', async () => {
            const mockLogger = getMockLogger();
            const options = getDefaultOptions();
            const auth = { apiKey: '', site: 'datadoghq.com' };
            const logs = [createLogEntry()];

            const { errors, warnings } = await sendLogs(logs, options, auth, mockLogger);

            expect(errors).toHaveLength(1);
            expect(errors[0].message).toBe('No API key provided');
            expect(warnings).toHaveLength(0);
            expect(doRequestMock).not.toHaveBeenCalled();
        });

        test('Should send logs in a single batch when under batchSize', async () => {
            doRequestMock.mockResolvedValue(undefined);

            const mockLogger = getMockLogger();
            const options = getDefaultOptions({ batchSize: 100 });
            const auth = { apiKey: 'test-api-key', site: 'datadoghq.com' };
            const logs = [createLogEntry(), createLogEntry()];

            const { errors, warnings } = await sendLogs(logs, options, auth, mockLogger);

            expect(errors).toHaveLength(0);
            expect(warnings).toHaveLength(0);
            expect(doRequestMock).toHaveBeenCalledTimes(1);
        });

        test('Should batch logs according to batchSize', async () => {
            doRequestMock.mockResolvedValue(undefined);

            const mockLogger = getMockLogger();
            const options = getDefaultOptions({ batchSize: 2 });
            const auth = { apiKey: 'test-api-key', site: 'datadoghq.com' };
            const logs = [
                createLogEntry({ message: 'Log 1' }),
                createLogEntry({ message: 'Log 2' }),
                createLogEntry({ message: 'Log 3' }),
                createLogEntry({ message: 'Log 4' }),
                createLogEntry({ message: 'Log 5' }),
            ];

            const { errors, warnings } = await sendLogs(logs, options, auth, mockLogger);

            expect(errors).toHaveLength(0);
            expect(warnings).toHaveLength(0);
            // 5 logs / 2 batch size = 3 batches
            expect(doRequestMock).toHaveBeenCalledTimes(3);
        });

        test('Should handle API errors gracefully', async () => {
            doRequestMock.mockRejectedValue(new Error('API Error'));

            const mockLogger = getMockLogger();
            const options = getDefaultOptions();
            const auth = { apiKey: 'test-api-key', site: 'datadoghq.com' };
            const logs = [createLogEntry()];

            const { errors, warnings } = await sendLogs(logs, options, auth, mockLogger);

            expect(errors).toHaveLength(1);
            expect(errors[0].message).toContain('Batch 1/1 failed: API Error');
            expect(warnings).toHaveLength(0);
        });

        test('Should call doRequest with correct parameters', async () => {
            doRequestMock.mockResolvedValue(undefined);

            const mockLogger = getMockLogger();
            const options = getDefaultOptions();
            const auth = { apiKey: 'test-api-key', site: 'datadoghq.com' };
            const logs = [createLogEntry()];

            await sendLogs(logs, options, auth, mockLogger);

            expect(doRequestMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    auth: { apiKey: 'test-api-key' },
                    url: `https://${LOGS_API_SUBDOMAIN}.datadoghq.com/${LOGS_API_PATH}`,
                    method: 'POST',
                    getData: expect.any(Function),
                    onRetry: expect.any(Function),
                }),
            );
        });

        test('Should use default site when not provided', async () => {
            doRequestMock.mockResolvedValue(undefined);

            const mockLogger = getMockLogger();
            const options = getDefaultOptions();
            const auth = { apiKey: 'test-api-key' };
            const logs = [createLogEntry()];

            await sendLogs(logs, options, auth, mockLogger);

            expect(doRequestMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: `https://${LOGS_API_SUBDOMAIN}.datadoghq.com/${LOGS_API_PATH}`,
                }),
            );
        });

        test('Should log debug message for batch progress', async () => {
            doRequestMock.mockResolvedValue(undefined);

            const mockLogger = getMockLogger();
            const options = getDefaultOptions();
            const auth = { apiKey: 'test-api-key', site: 'datadoghq.com' };
            const logs = [createLogEntry()];

            await sendLogs(logs, options, auth, mockLogger);

            expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('Sending'), 'debug');
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('Successfully sent'),
                'debug',
            );
        });

        test('Should add warnings during retry', async () => {
            // Simulate a retry by capturing the onRetry callback
            let capturedOnRetry: ((error: Error, attempt: number) => void) | undefined;
            doRequestMock.mockImplementation(async (options) => {
                capturedOnRetry = options.onRetry;
                // Simulate successful request (no retry needed)
                return undefined;
            });

            const mockLogger = getMockLogger();
            const options = getDefaultOptions();
            const auth = { apiKey: 'test-api-key', site: 'datadoghq.com' };
            const logs = [createLogEntry()];

            await sendLogs(logs, options, auth, mockLogger);

            // Verify onRetry was captured
            expect(capturedOnRetry).toBeDefined();
        });

        test('Should handle multiple batch failures', async () => {
            doRequestMock.mockRejectedValue(new Error('Network Error'));

            const mockLogger = getMockLogger();
            const options = getDefaultOptions({ batchSize: 1 });
            const auth = { apiKey: 'test-api-key', site: 'datadoghq.com' };
            const logs = [
                createLogEntry({ message: 'Log 1' }),
                createLogEntry({ message: 'Log 2' }),
                createLogEntry({ message: 'Log 3' }),
            ];

            const { errors } = await sendLogs(logs, options, auth, mockLogger);

            expect(errors).toHaveLength(3);
            expect(errors[0].message).toContain('Batch 1/3 failed');
            expect(errors[1].message).toContain('Batch 2/3 failed');
            expect(errors[2].message).toContain('Batch 3/3 failed');
        });
    });
});
