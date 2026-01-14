// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPluginsArg, Logger } from '@dd/core/types';
import type { LogsOptions } from '@dd/logs-plugin/types';
import { getPlugins } from '@dd/logs-plugin';
import {
    defaultPluginOptions,
    getContextMock,
    getMockData,
    getMockLogger,
    getMockStores,
    defaultAuth,
} from '@dd/tests/_jest/helpers/mocks';

import { sendLogs } from './sender';

jest.mock('@dd/logs-plugin/sender', () => ({
    sendLogs: jest.fn(),
}));

const mockSendLogs = jest.mocked(sendLogs);

// Helper to create a mock logger with jest.fn() for all methods
const createSpyLogger = (): Logger => {
    const mockLogger = getMockLogger();
    return {
        ...mockLogger,
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    };
};

// Helper to build a GetPluginsArg with custom stores
const buildPluginsArg = (
    optionsOverrides: Partial<Parameters<typeof getPlugins>[0]['options']> = {},
    contextOverrides: Partial<Parameters<typeof getPlugins>[0]['context']> = {},
    storesOverrides: Partial<Parameters<typeof getPlugins>[0]['stores']> = {},
): GetPluginsArg => {
    return {
        options: {
            ...defaultPluginOptions,
            ...optionsOverrides,
            auth: { ...defaultAuth, ...optionsOverrides.auth },
        },
        context: getContextMock(contextOverrides),
        data: getMockData(),
        stores: getMockStores(storesOverrides),
        bundler: {},
    };
};

describe('Logs Plugin', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockSendLogs.mockResolvedValue({ errors: [], warnings: [] });
    });

    describe('getPlugins', () => {
        const cases: {
            description: string;
            options: LogsOptions | undefined;
            expectedPlugins: number;
        }[] = [
            {
                description: 'not initialize if disabled explicitly',
                options: { enable: false },
                expectedPlugins: 0,
            },
            {
                description: 'not initialize if logs config is not present',
                options: undefined,
                expectedPlugins: 0,
            },
            {
                description: 'initialize with minimal valid config',
                options: {},
                expectedPlugins: 1,
            },
            {
                description: 'initialize with enable: true',
                options: { enable: true },
                expectedPlugins: 1,
            },
            {
                description: 'initialize with custom service',
                options: { service: 'my-service' },
                expectedPlugins: 1,
            },
            {
                description: 'initialize with all options specified',
                options: {
                    enable: true,
                    service: 'my-service',
                    env: 'production',
                    tags: ['team:frontend', 'project:myapp'],
                    logLevel: 'warn',
                    includeBundlerLogs: true,
                    includePluginLogs: true,
                    includeModuleEvents: false,
                    batchSize: 50,
                    includeTimings: true,
                },
                expectedPlugins: 1,
            },
        ];

        test.each(cases)('Should $description', ({ options, expectedPlugins }) => {
            const result = getPlugins(buildPluginsArg({ logs: options }));
            expect(result).toHaveLength(expectedPlugins);
        });

        test('Should return plugin with enforce: post', () => {
            const result = getPlugins(buildPluginsArg({ logs: {} }));
            expect(result).toHaveLength(1);
            expect(result[0].enforce).toBe('post');
        });

        test('Should return plugin with all bundler handlers', () => {
            const result = getPlugins(buildPluginsArg({ logs: {} }));
            expect(result).toHaveLength(1);
            const plugin = result[0];
            expect(plugin.esbuild).toBeDefined();
            expect(plugin.rollup).toBeDefined();
            expect(plugin.vite).toBeDefined();
            expect(plugin.webpack).toBeDefined();
            expect(plugin.rspack).toBeDefined();
        });
    });

    describe('buildReport hook', () => {
        test('Should collect plugin logs from stores when includePluginLogs is true', async () => {
            const stores = {
                logs: [
                    {
                        type: 'info' as const,
                        message: 'Plugin log 1',
                        pluginName: 'test-plugin',
                        time: Date.now(),
                    },
                    {
                        type: 'warn' as const,
                        message: 'Plugin log 2',
                        pluginName: 'other-plugin',
                        time: Date.now(),
                    },
                ],
            };

            const result = getPlugins(
                buildPluginsArg({ logs: { includePluginLogs: true } }, {}, stores),
            );

            expect(result).toHaveLength(1);
            const plugin = result[0];
            expect(plugin.buildReport).toBeDefined();

            await plugin.buildReport!({} as any);

            expect(mockSendLogs).toHaveBeenCalledTimes(1);
            const sentLogs = mockSendLogs.mock.calls[0][0];
            expect(sentLogs.length).toBeGreaterThanOrEqual(2);

            const pluginLogs = sentLogs.filter((l: any) => l.ddsource === 'build-plugins');
            expect(pluginLogs.some((l: any) => l.message === 'Plugin log 1')).toBe(true);
            expect(pluginLogs.some((l: any) => l.message === 'Plugin log 2')).toBe(true);
        });

        test('Should not collect plugin logs when includePluginLogs is false', async () => {
            const stores = {
                logs: [
                    {
                        type: 'info' as const,
                        message: 'Plugin log 1',
                        pluginName: 'test-plugin',
                        time: Date.now(),
                    },
                ],
            };

            const result = getPlugins(
                buildPluginsArg({ logs: { includePluginLogs: false } }, {}, stores),
            );

            expect(result).toHaveLength(1);
            const plugin = result[0];

            await plugin.buildReport!({} as any);

            // sendLogs not called because no logs collected (plugin logs disabled, no bundler logs)
            expect(mockSendLogs).not.toHaveBeenCalled();
        });

        test('Should filter logs by logLevel', async () => {
            const stores = {
                logs: [
                    {
                        type: 'debug' as const,
                        message: 'Debug log',
                        pluginName: 'test',
                        time: Date.now(),
                    },
                    {
                        type: 'info' as const,
                        message: 'Info log',
                        pluginName: 'test',
                        time: Date.now(),
                    },
                    {
                        type: 'warn' as const,
                        message: 'Warn log',
                        pluginName: 'test',
                        time: Date.now(),
                    },
                    {
                        type: 'error' as const,
                        message: 'Error log',
                        pluginName: 'test',
                        time: Date.now(),
                    },
                ],
            };

            const result = getPlugins(
                buildPluginsArg(
                    { logs: { includePluginLogs: true, logLevel: 'warn' } },
                    {},
                    stores,
                ),
            );

            await result[0].buildReport!({} as any);

            expect(mockSendLogs).toHaveBeenCalledTimes(1);
            const sentLogs = mockSendLogs.mock.calls[0][0];

            // Only warn and error logs should be sent (logLevel: warn filters out debug and info)
            const messages = sentLogs.map((l: any) => l.message);
            expect(messages).not.toContain('Debug log');
            expect(messages).not.toContain('Info log');
            expect(messages).toContain('Warn log');
            expect(messages).toContain('Error log');
        });

        test('Should include timing data when includeTimings is true', async () => {
            const stores = {
                timings: [
                    {
                        label: 'Plugin A',
                        total: 150,
                        pluginName: 'plugin-a',
                        spans: [],
                        tags: [],
                        logLevel: 'debug' as const,
                    },
                    {
                        label: 'Plugin B',
                        total: 200,
                        pluginName: 'plugin-b',
                        spans: [],
                        tags: [],
                        logLevel: 'debug' as const,
                    },
                ],
            };

            const result = getPlugins(
                buildPluginsArg({ logs: { includeTimings: true } }, {}, stores),
            );

            await result[0].buildReport!({} as any);

            expect(mockSendLogs).toHaveBeenCalledTimes(1);
            const sentLogs = mockSendLogs.mock.calls[0][0];

            expect(sentLogs.length).toBe(2);
            expect(sentLogs[0].message).toContain('Timing: Plugin A');
            expect(sentLogs[0].timing).toEqual({ label: 'Plugin A', total: 150 });
            expect(sentLogs[1].message).toContain('Timing: Plugin B');
            expect(sentLogs[1].timing).toEqual({ label: 'Plugin B', total: 200 });
        });

        test('Should not include timing data when includeTimings is false', async () => {
            const stores = {
                timings: [
                    {
                        label: 'Plugin A',
                        total: 150,
                        pluginName: 'plugin-a',
                        spans: [],
                        tags: [],
                        logLevel: 'debug' as const,
                    },
                ],
            };

            const result = getPlugins(
                buildPluginsArg({ logs: { includeTimings: false } }, {}, stores),
            );

            await result[0].buildReport!({} as any);

            // No logs to send because timings disabled and no other logs
            expect(mockSendLogs).not.toHaveBeenCalled();
        });

        test('Should not send logs if there are none', async () => {
            const result = getPlugins(
                buildPluginsArg(
                    { logs: { includePluginLogs: true, includeTimings: false } },
                    {},
                    { logs: [], timings: [] },
                ),
            );

            await result[0].buildReport!({} as any);

            expect(mockSendLogs).not.toHaveBeenCalled();
        });

        test('Should log errors when sendLogs returns errors', async () => {
            const spyLogger = createSpyLogger();
            const stores = {
                logs: [
                    {
                        type: 'info' as const,
                        message: 'Test log',
                        pluginName: 'test',
                        time: Date.now(),
                    },
                ],
            };

            mockSendLogs.mockResolvedValue({
                errors: [new Error('API Error 1'), new Error('API Error 2')],
                warnings: [],
            });

            const result = getPlugins(
                buildPluginsArg(
                    { logs: { includePluginLogs: true } },
                    { getLogger: () => spyLogger },
                    stores,
                ),
            );

            await result[0].buildReport!({} as any);

            expect(spyLogger.error).toHaveBeenCalledTimes(2);
            expect(spyLogger.error).toHaveBeenCalledWith(expect.stringContaining('API Error 1'));
            expect(spyLogger.error).toHaveBeenCalledWith(expect.stringContaining('API Error 2'));
        });

        test('Should log warnings when sendLogs returns warnings', async () => {
            const spyLogger = createSpyLogger();
            const stores = {
                logs: [
                    {
                        type: 'info' as const,
                        message: 'Test log',
                        pluginName: 'test',
                        time: Date.now(),
                    },
                ],
            };

            mockSendLogs.mockResolvedValue({
                errors: [],
                warnings: ['Warning 1', 'Warning 2'],
            });

            const result = getPlugins(
                buildPluginsArg(
                    { logs: { includePluginLogs: true } },
                    { getLogger: () => spyLogger },
                    stores,
                ),
            );

            await result[0].buildReport!({} as any);

            expect(spyLogger.warn).toHaveBeenCalledTimes(2);
            expect(spyLogger.warn).toHaveBeenCalledWith('Warning 1');
            expect(spyLogger.warn).toHaveBeenCalledWith('Warning 2');
        });

        test('Should log success message after sending logs', async () => {
            const spyLogger = createSpyLogger();
            const stores = {
                logs: [
                    {
                        type: 'info' as const,
                        message: 'Log 1',
                        pluginName: 'test',
                        time: Date.now(),
                    },
                    {
                        type: 'info' as const,
                        message: 'Log 2',
                        pluginName: 'test',
                        time: Date.now(),
                    },
                ],
            };

            const result = getPlugins(
                buildPluginsArg(
                    { logs: { includePluginLogs: true } },
                    { getLogger: () => spyLogger },
                    stores,
                ),
            );

            await result[0].buildReport!({} as any);

            expect(spyLogger.info).toHaveBeenCalledWith(expect.stringContaining('Sent'));
            expect(spyLogger.info).toHaveBeenCalledWith(expect.stringContaining('logs to Datadog'));
        });
    });

    describe('log entry structure', () => {
        test('Should create log entries with correct structure', async () => {
            const stores = {
                logs: [
                    {
                        type: 'info' as const,
                        message: 'Test message',
                        pluginName: 'test-plugin',
                        time: Date.now(),
                    },
                ],
            };

            const result = getPlugins(
                buildPluginsArg(
                    {
                        logs: {
                            includePluginLogs: true,
                            service: 'my-service',
                            tags: ['env:test', 'team:myteam'],
                        },
                    },
                    {},
                    stores,
                ),
            );

            await result[0].buildReport!({} as any);

            expect(mockSendLogs).toHaveBeenCalledTimes(1);
            const sentLogs = mockSendLogs.mock.calls[0][0];
            const logEntry = sentLogs[0];

            expect(logEntry.message).toBe('Test message');
            expect(logEntry.status).toBe('info');
            expect(logEntry.ddsource).toBe('build-plugins');
            expect(logEntry.ddtags).toBe('env:test,team:myteam');
            expect(logEntry.service).toBe('my-service');
            expect(logEntry.hostname).toBeDefined();
            expect(logEntry.bundler).toEqual({
                name: expect.any(String),
                version: expect.any(String),
                outDir: expect.any(String),
            });
            expect(logEntry.plugin).toBe('test-plugin');
            expect(logEntry.timestamp).toEqual(expect.any(Number));
        });

        test('Should include env when specified', async () => {
            const stores = {
                logs: [
                    {
                        type: 'info' as const,
                        message: 'Test',
                        pluginName: 'test',
                        time: Date.now(),
                    },
                ],
            };

            const result = getPlugins(
                buildPluginsArg(
                    { logs: { includePluginLogs: true, env: 'production' } },
                    {},
                    stores,
                ),
            );

            await result[0].buildReport!({} as any);

            const sentLogs = mockSendLogs.mock.calls[0][0];
            expect(sentLogs[0].env).toBe('production');
        });

        test('Should not include env when not specified', async () => {
            const stores = {
                logs: [
                    {
                        type: 'info' as const,
                        message: 'Test',
                        pluginName: 'test',
                        time: Date.now(),
                    },
                ],
            };

            const result = getPlugins(
                buildPluginsArg({ logs: { includePluginLogs: true } }, {}, stores),
            );

            await result[0].buildReport!({} as any);

            const sentLogs = mockSendLogs.mock.calls[0][0];
            expect(sentLogs[0].env).toBeUndefined();
        });
    });
});
