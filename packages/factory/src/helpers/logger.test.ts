// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogRspackPlugin } from '@datadog/rspack-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { rm } from '@dd/core/helpers/fs';
import { getSendLog } from '@dd/core/helpers/log';
import { getUniqueId } from '@dd/core/helpers/strings';
import type {
    BundlerFullName,
    GetPluginsArg,
    GlobalData,
    GlobalStores,
    Logger,
    Options,
} from '@dd/core/types';
import { getLoggerFactory, NAME_SEP } from '@dd/factory/helpers/logger';
import { getAsyncQueuePlugins } from '@dd/internal-async-queue-plugin';
import { prepareWorkingDir } from '@dd/tests/_jest/helpers/env';
import { getWebpackPlugin } from '@dd/tests/_jest/helpers/getWebpackPlugin';
import {
    defaultEntry,
    defaultPluginOptions,
    getMockData,
    getMockStores,
} from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS } from '@dd/tests/_jest/helpers/runBundlers';
import { allBundlers } from '@dd/tools/bundlers';
// import { allPlugins } from '@dd/tools/plugins';
import path from 'path';
import stripAnsi from 'strip-ansi';
import webpack4 from 'webpack4';
import webpack5 from 'webpack5';

// Keep a reference to console.log for debugging.
const log = console.log;
const error = console.error;
const warn = console.warn;

// Spy on console to avoid logs in the console and to assert.
jest.spyOn(console, 'log').mockImplementation(log);
jest.spyOn(console, 'error').mockImplementation(error);
jest.spyOn(console, 'warn').mockImplementation(warn);

const logMock = jest.mocked(console.log);
const errorMock = jest.mocked(console.error);
const warnMock = jest.mocked(console.warn);

// Access logs and strip colors.
const getOutput = (mock: jest.Mock, index: number) => stripAnsi(mock.mock.calls[index][0]);

// Mock getSendLog for testing forward option
jest.mock('@dd/core/helpers/log', () => ({
    getSendLog: jest.fn(() => jest.fn().mockResolvedValue(undefined)),
}));
// Mock the getLogger function from the context.
jest.mock('@dd/factory/helpers/logger', () => {
    const originalModule = jest.requireActual('@dd/factory/helpers/logger');
    return {
        ...originalModule,
        getLoggerFactory: jest.fn(originalModule.getLoggerFactory),
    };
});

jest.mock('@dd/internal-async-queue-plugin', () => {
    const originalModule = jest.requireActual('@dd/internal-async-queue-plugin');
    return {
        ...originalModule,
        getAsyncQueuePlugins: jest.fn(originalModule.getAsyncQueuePlugins),
    };
});

const mockGetSendLog = jest.mocked(getSendLog);
const mockGetLoggerFactory = jest.mocked(getLoggerFactory);
const mockGetAsyncQueuePlugins = jest.mocked(getAsyncQueuePlugins);

describe('logger', () => {
    describe('getLoggerFactory', () => {
        const setupLogger = (name: string): [Logger, GlobalStores, GlobalData] => {
            const mockStores = getMockStores();
            const mockData = getMockData();
            const loggerFactory = getLoggerFactory(mockData, mockStores, 'debug');
            const logger = loggerFactory(name);

            return [logger, mockStores, mockData];
        };

        const useLogger = (logger: Logger) => {
            logger.error('An error occurred.');
            logger.warn('A warning message.');
            logger.info('An info message.');
            logger.debug('A debug message.');
        };

        const assessLogger = (logger: Logger) => {
            expect(logger.getLogger).toEqual(expect.any(Function));
            expect(logger.error).toEqual(expect.any(Function));
            expect(logger.warn).toEqual(expect.any(Function));
            expect(logger.info).toEqual(expect.any(Function));
            expect(logger.debug).toEqual(expect.any(Function));
        };

        const assessLogs = (name: string) => {
            expect(logMock).toHaveBeenCalledTimes(2);
            expect(getOutput(logMock, 0)).toBe(`[info|esbuild|${name}] An info message.`);
            expect(getOutput(logMock, 1)).toBe(`[debug|esbuild|${name}] A debug message.`);

            expect(errorMock).toHaveBeenCalledTimes(1);
            expect(getOutput(errorMock, 0)).toBe(`[error|esbuild|${name}] An error occurred.`);

            expect(warnMock).toHaveBeenCalledTimes(1);
            expect(getOutput(warnMock, 0)).toBe(`[warn|esbuild|${name}] A warning message.`);
        };

        const assessStores = (name: string, stores: GlobalStores) => {
            expect(stores.logs).toHaveLength(4);
            const baseLog = {
                bundler: 'esbuild',
                pluginName: name,
                time: expect.any(Number),
            };
            expect(stores.logs[0]).toEqual({
                ...baseLog,
                type: 'error',
                message: 'An error occurred.',
            });
            expect(stores.logs[1]).toEqual({
                ...baseLog,
                type: 'warn',
                message: 'A warning message.',
            });
            expect(stores.logs[2]).toEqual({
                ...baseLog,
                type: 'info',
                message: 'An info message.',
            });
            expect(stores.logs[3]).toEqual({
                ...baseLog,
                type: 'debug',
                message: 'A debug message.',
            });

            expect(stores.errors).toEqual(['An error occurred.']);
            expect(stores.warnings).toEqual(['A warning message.']);
        };

        describe('Logger', () => {
            test('Should return a logger factory.', () => {
                const [logger] = setupLogger('testLogger');

                assessLogger(logger);
            });

            test('Should log as expected', () => {
                const [logger] = setupLogger('testLogger');
                useLogger(logger);

                assessLogs('testLogger');
            });

            test('Should store logs as expected.', () => {
                const [logger, stores] = setupLogger('testLogger');
                useLogger(logger);

                assessStores('testLogger', stores);
            });
        });

        describe('Time logger', () => {
            beforeAll(() => {
                jest.useFakeTimers();
            });
            afterAll(() => {
                jest.useRealTimers();
            });
            test('Should log a duration.', () => {
                const [logger] = setupLogger('testLogger');
                // Basic usage.
                const timer = logger.time('test time 1');
                timer.end();

                // Use a specific log level.
                const timer2 = logger.time('test time 2', { level: 'error' });
                timer2.end();

                expect(logMock).toHaveBeenCalledTimes(3);
                expect(errorMock).toHaveBeenCalledTimes(1);
                expect(getOutput(logMock, 0)).toBe(
                    `[debug|esbuild|testLogger] [test time 1] : start`,
                );
                expect(getOutput(logMock, 1)).toBe(
                    `[debug|esbuild|testLogger] [test time 1] : 0ms`,
                );
                expect(getOutput(logMock, 2)).toBe(
                    `[debug|esbuild|testLogger] [test time 2] : start`,
                );
                expect(getOutput(errorMock, 0)).toBe(
                    `[error|esbuild|testLogger] [test time 2] : 0ms`,
                );
            });

            test('Should resume and end a timer.', () => {
                const [logger] = setupLogger('testLogger');
                const timer = logger.time('test time 1');
                jest.advanceTimersByTime(100);
                timer.pause();
                jest.advanceTimersByTime(100);
                timer.resume();
                jest.advanceTimersByTime(100);
                timer.end();

                expect(logMock).toHaveBeenCalledTimes(2);
                expect(getOutput(logMock, 0)).toBe(
                    `[debug|esbuild|testLogger] [test time 1] : start`,
                );
                expect(getOutput(logMock, 1)).toBe(
                    `[debug|esbuild|testLogger] [test time 1] : 200ms`,
                );
            });

            test('Should not auto start the timer.', () => {
                const [logger] = setupLogger('testLogger');
                const timer = logger.time('test time 1', { start: false });
                jest.advanceTimersByTime(100);
                timer.resume();
                jest.advanceTimersByTime(100);
                timer.end();

                expect(logMock).toHaveBeenCalledTimes(2);
                expect(getOutput(logMock, 0)).toBe(
                    `[debug|esbuild|testLogger] [test time 1] : start`,
                );
                expect(getOutput(logMock, 1)).toBe(
                    `[debug|esbuild|testLogger] [test time 1] : 100ms`,
                );
            });

            test('Should not log the timer.', () => {
                const [logger] = setupLogger('testLogger');
                const timer = logger.time('test time 1', { log: false });
                timer.end();

                expect(logMock).not.toHaveBeenCalled();
            });

            test('Should report the timers in the build report.', () => {
                const [logger, buildReport] = setupLogger('testLogger');
                const timer = logger.time('test time 1');
                jest.advanceTimersByTime(100);
                timer.pause();
                jest.advanceTimersByTime(100);
                timer.resume();
                jest.advanceTimersByTime(200);
                timer.end();

                expect(buildReport.timings).toHaveLength(1);
                const timing = buildReport.timings[0];
                expect(timing).toEqual({
                    label: 'test time 1',
                    pluginName: 'testLogger',
                    spans: [
                        {
                            start: expect.any(Number),
                            end: expect.any(Number),
                            tags: ['plugin:testLogger'],
                        },
                        {
                            start: expect.any(Number),
                            end: expect.any(Number),
                            tags: ['plugin:testLogger'],
                        },
                    ],
                    tags: ['plugin:testLogger', 'level:debug'],
                    total: 300,
                    logLevel: 'debug',
                });
                expect(timing.spans[0].end! - timing.spans[0].start).toBe(100);
                expect(timing.spans[1].end! - timing.spans[1].start).toBe(200);
            });

            test('Should tag the timer.', () => {
                const [logger] = setupLogger('testLogger');
                const timer = logger.time('test time 1');
                timer.tag(['tag1', 'tag2']);
                timer.end();

                expect(timer.timer.tags).toContain('tag1');
                expect(timer.timer.tags).toContain('tag2');
            });

            test('Should tag the spans.', () => {
                const [logger] = setupLogger('testLogger');
                const timer = logger.time('test time 1');
                timer.tag(['tag1', 'tag2'], { span: true });
                timer.end();

                expect(timer.timer.spans[0].tags).toContain('tag1');
                expect(timer.timer.spans[0].tags).toContain('tag2');
            });
        });

        describe('Sub logger', () => {
            test('Should return a logger factory.', () => {
                const [logger] = setupLogger('testLogger');
                const subLogger = logger.getLogger('subLogger');

                assessLogger(subLogger);
            });

            test('Should log as expected', () => {
                const [logger] = setupLogger('testLogger');
                const subLogger = logger.getLogger('subLogger');
                useLogger(subLogger);

                assessLogs(`testLogger${NAME_SEP}subLogger`);
            });

            test('Should store logs as expected.', () => {
                const [logger, stores] = setupLogger('testLogger');
                const subLogger = logger.getLogger('subLogger');
                useLogger(subLogger);

                assessStores(`testLogger${NAME_SEP}subLogger`, stores);
            });
        });

        describe('Forward option', () => {
            test('Should add promises to queue when forward option is used', () => {
                const [logger, stores] = setupLogger('testLogger');
                const mockSendLogFn = jest.fn().mockResolvedValue(undefined);
                mockGetSendLog.mockReturnValue(mockSendLogFn);

                // Log with forward option
                logger.info('Test forwarded log', { forward: true });

                // Check that sendLog was called
                expect(mockSendLogFn).toHaveBeenCalledTimes(1);

                // Check that promises were added to the queue
                expect(stores.queue).toHaveLength(1);

                // Check that sendLog function was called with correct parameters
                expect(mockSendLogFn).toHaveBeenCalledWith({
                    message: 'Test forwarded log',
                    context: { plugin: 'testLogger', status: 'info' },
                });
            });

            test('Should not add to queue when forward option is not used', () => {
                const [logger, stores] = setupLogger('testLogger');

                // Log without forward option
                logger.info('Test log');
                logger.error('Test error');

                // Check that queue is empty
                expect(stores.queue).toHaveLength(0);
            });

            describe('Full build', () => {
                let stores: GlobalStores;
                let logger: Logger;
                const promiseResolves: (() => void)[] = [];
                const mockAsyncCall = jest.fn();
                const outDirsToRm: string[] = [];
                const buildPromises: Promise<any>[] = [];

                beforeAll(async () => {
                    // Mocks.
                    [logger, stores] = setupLogger('testLogger');

                    // Use an async function, manually resolved from outside.
                    const mockSendLogFn = jest.fn().mockImplementation(() => {
                        return new Promise((resolve) => {
                            promiseResolves.push(() => {
                                mockAsyncCall();
                                resolve(undefined);
                            });
                        });
                    });
                    mockGetSendLog.mockReturnValue(mockSendLogFn);
                    mockGetLoggerFactory.mockReturnValue(() => logger);

                    // Mock the async queue plugins to use our mock stores.
                    mockGetAsyncQueuePlugins.mockImplementation((args: GetPluginsArg) => {
                        const original: typeof getAsyncQueuePlugins = jest.requireActual(
                            '@dd/internal-async-queue-plugin',
                        ).getAsyncQueuePlugins;
                        args.stores = stores;
                        return original(args);
                    });

                    const pluginConfig: Options = {
                        ...defaultPluginOptions,
                        customPlugins: ({ context }) => {
                            context
                                .getLogger('testLogger')
                                .info('Test forwarded log', { forward: true });
                            return [];
                        },
                    };

                    // Prepare the working directory, where we'll output our builds.
                    const seed: string = `${Math.abs(jest.getSeed())}.${getUniqueId()}`;
                    const workingDir = await prepareWorkingDir(seed);
                    outDirsToRm.push(workingDir);

                    // Using these plugins to target the dev files,
                    // so the mocks are correctly injected.
                    const allPlugins: Record<BundlerFullName, (config: Options) => any> = {
                        webpack4: (config) => getWebpackPlugin(config, webpack4),
                        webpack5: (config) => getWebpackPlugin(config, webpack5),
                        rspack: (config) => datadogRspackPlugin(config),
                        esbuild: (config) => datadogEsbuildPlugin(config),
                        rollup: (config) => datadogRollupPlugin(config),
                        vite: (config) => datadogVitePlugin(config),
                    };

                    // Build with all the bundlers.
                    for (const bundler of BUNDLERS) {
                        const getPlugin = allPlugins[bundler.name];
                        const { run, config } = allBundlers[bundler.name];
                        // Store the promises without awaiting them.
                        buildPromises.push(
                            run(
                                config({
                                    workingDir,
                                    entry: { main: path.resolve(workingDir, defaultEntry) },
                                    outDir: path.join(workingDir, bundler.name),
                                    plugins: [getPlugin(pluginConfig)],
                                }),
                            ),
                        );
                    }
                });

                afterAll(async () => {
                    if (process.env.NO_CLEANUP) {
                        return;
                    }
                    try {
                        await Promise.all(outDirsToRm.map((dir) => rm(dir)));
                    } catch (e) {
                        // Ignore errors.
                    }
                });

                test('Should handle async queue processing', async () => {
                    // Verify promise was added to queue
                    expect(stores.queue).toHaveLength(BUNDLERS.length);
                    // We should not have called the async function yet.
                    expect(mockAsyncCall).not.toHaveBeenCalled();

                    // Resolve the awaiting promises, so the builds can complete.
                    promiseResolves.forEach((resolve) => resolve());
                    await Promise.all(buildPromises);

                    // Verify the promises were resolved
                    expect(mockAsyncCall).toHaveBeenCalledTimes(BUNDLERS.length);
                });
            });
        });
    });
});
