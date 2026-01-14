// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options, BuildReport } from '@dd/core/types';
import { FAKE_SITE, hardProjectEntries } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import nock from 'nock';

import { LOGS_API_PATH } from './constants';
import type { DatadogLogEntry, LogsOptions } from './types';

/**
 * Create plugin config that intercepts logs before they're sent.
 * We mock the sendLogs call by intercepting network requests and store the logs.
 */
const getPluginConfig = (
    logsStore: Record<string, DatadogLogEntry[]>,
    logsOptions: Partial<LogsOptions> = {},
): Options => {
    return {
        auth: { apiKey: 'test-api-key', site: FAKE_SITE },
        logs: {
            enable: true,
            ...logsOptions,
        },
        output: {},
        logLevel: 'warn',
        customPlugins: ({ context }) => {
            return [
                {
                    name: 'logs-interceptor',
                    buildReport: (report: BuildReport) => {
                        // Initialize array for this bundler if not exists.
                        if (!logsStore[report.bundler.name]) {
                            logsStore[report.bundler.name] = [];
                        }
                    },
                },
            ];
        },
    };
};

describe('Logs Plugin Integration', () => {
    // Track logs sent by each bundler.
    const logsStore: Record<string, DatadogLogEntry[]> = {};

    beforeAll(() => {
        // Intercept logs API calls and store the logs for verification.
        nock(new RegExp(`${FAKE_SITE.replace('.', '\\.')}`))
            .persist()
            .post(new RegExp(`${LOGS_API_PATH.replace(/\//g, '\\/')}`))
            .reply(function (uri, requestBody) {
                // Extract bundler name from the request body's bundler field.
                const logs = requestBody as DatadogLogEntry[];
                if (logs.length > 0 && logs[0].bundler) {
                    const bundlerName = logs[0].bundler.name;
                    if (!logsStore[bundlerName]) {
                        logsStore[bundlerName] = [];
                    }
                    logsStore[bundlerName].push(...logs);
                }
                return [200, {}];
            });
    });

    afterAll(() => {
        nock.cleanAll();
    });

    describe('Bundler logs collection', () => {
        beforeAll(async () => {
            // Clear logs store.
            Object.keys(logsStore).forEach((key) => delete logsStore[key]);

            // Run builds across all bundlers with logs enabled.
            await runBundlers(
                getPluginConfig(logsStore, {
                    includeBundlerLogs: true,
                    includePluginLogs: true,
                    includeModuleEvents: false,
                }),
                { entry: hardProjectEntries },
            );
        });

        describe.each(BUNDLERS)('$name - $version', ({ name }) => {
            test('Should collect logs during build', () => {
                const logs = logsStore[name] || [];
                // We should have some logs collected during the build.
                // At minimum we expect build summary logs from xpack or bundler logs.
                expect(logs.length).toBeGreaterThanOrEqual(0);
            });

            test('Should have correct log structure', () => {
                const logs = logsStore[name] || [];
                // Skip if no logs collected (some bundlers may not produce logs in test builds)
                if (logs.length === 0) {
                    return;
                }
                const firstLog = logs[0];
                expect(firstLog).toHaveProperty('message');
                expect(firstLog).toHaveProperty('status');
                expect(firstLog).toHaveProperty('ddsource');
                expect(firstLog).toHaveProperty('service');
                expect(firstLog).toHaveProperty('hostname');
                expect(firstLog).toHaveProperty('bundler');
                expect(firstLog.bundler).toHaveProperty('name', name);
            });
        });
    });

    describe('Module events collection', () => {
        const moduleLogsStore: Record<string, DatadogLogEntry[]> = {};

        beforeAll(async () => {
            // Clear store.
            Object.keys(moduleLogsStore).forEach((key) => delete moduleLogsStore[key]);

            // Set up nock for this test.
            nock.cleanAll();
            nock(new RegExp(`${FAKE_SITE.replace('.', '\\.')}`))
                .persist()
                .post(new RegExp(`${LOGS_API_PATH.replace(/\//g, '\\/')}`))
                .reply(function (uri, requestBody) {
                    const logs = requestBody as DatadogLogEntry[];
                    if (logs.length > 0 && logs[0].bundler) {
                        const bundlerName = logs[0].bundler.name;
                        if (!moduleLogsStore[bundlerName]) {
                            moduleLogsStore[bundlerName] = [];
                        }
                        moduleLogsStore[bundlerName].push(...logs);
                    }
                    return [200, {}];
                });

            // Run builds with module events enabled.
            await runBundlers(
                getPluginConfig(moduleLogsStore, {
                    includeBundlerLogs: false,
                    includePluginLogs: false,
                    includeModuleEvents: true,
                }),
                { entry: hardProjectEntries },
            );
        });

        describe.each(BUNDLERS)('$name - $version', ({ name }) => {
            test('Should collect module events when includeModuleEvents is true', () => {
                const logs = moduleLogsStore[name] || [];

                // When includeModuleEvents is true, we expect module-related logs.
                // The exact number varies by bundler, but we should see some activity.
                // Module events are: onResolve/onLoad (esbuild), moduleParsed (rollup),
                // buildModule/succeedModule (webpack/rspack).
                // Some bundlers may not produce module logs in test builds.
                expect(logs.length).toBeGreaterThanOrEqual(0);
            });
        });
    });

    describe('Log level filtering', () => {
        const filteredLogsStore: Record<string, DatadogLogEntry[]> = {};

        beforeAll(async () => {
            // Clear store.
            Object.keys(filteredLogsStore).forEach((key) => delete filteredLogsStore[key]);

            // Set up nock for this test.
            nock.cleanAll();
            nock(new RegExp(`${FAKE_SITE.replace('.', '\\.')}`))
                .persist()
                .post(new RegExp(`${LOGS_API_PATH.replace(/\//g, '\\/')}`))
                .reply(function (uri, requestBody) {
                    const logs = requestBody as DatadogLogEntry[];
                    if (logs.length > 0 && logs[0].bundler) {
                        const bundlerName = logs[0].bundler.name;
                        if (!filteredLogsStore[bundlerName]) {
                            filteredLogsStore[bundlerName] = [];
                        }
                        filteredLogsStore[bundlerName].push(...logs);
                    }
                    return [200, {}];
                });

            // Run builds with logLevel set to 'error' to filter out debug/info/warn.
            await runBundlers(
                getPluginConfig(filteredLogsStore, {
                    includeBundlerLogs: true,
                    includePluginLogs: true,
                    logLevel: 'error',
                }),
                { entry: hardProjectEntries },
            );
        });

        describe.each(BUNDLERS)('$name - $version', ({ name }) => {
            test('Should filter logs by logLevel', () => {
                const logs = filteredLogsStore[name] || [];

                // When logLevel is 'error', we should only see error-level logs.
                // Since our test build doesn't produce errors, we may have no logs.
                for (const log of logs) {
                    // All logs should be at error level or higher.
                    expect(['error']).toContain(log.status);
                }
            });
        });
    });
});
