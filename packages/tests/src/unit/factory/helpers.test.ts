// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BuildReport, GlobalContext, Logger, Options } from '@dd/core/types';
import { getLoggerFactory, NAME_SEP } from '@dd/factory/helpers';
import { BUNDLER_VERSIONS } from '@dd/tests/_jest/helpers/constants';
import { defaultPluginOptions, getMockBuild } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import stripAnsi from 'strip-ansi';

// Keep a reference to console.log for debugging.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const log = console.log;

// Spy on console to avoid logs in the console and to assert.
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

const logMock = jest.mocked(console.log);
const errorMock = jest.mocked(console.error);
const warnMock = jest.mocked(console.warn);

// Access logs and strip colors.
const getOutput = (mock: jest.Mock, index: number) => stripAnsi(mock.mock.calls[index][0]);

describe('Factory Helpers', () => {
    // Intercept contexts to verify it at the moment they're used.
    const initialContexts: Record<string, GlobalContext> = {};
    const cwds: Record<string, string> = {};
    let workingDir: string;

    beforeAll(async () => {
        const pluginConfig: Options = {
            ...defaultPluginOptions,
            // Use a custom plugin to intercept contexts to verify it at initialization.
            customPlugins: (opts, context) => {
                const bundlerName = context.bundler.fullName;
                initialContexts[bundlerName] = JSON.parse(JSON.stringify(context));

                // These are functions, so they can't be serialized with parse/stringify.
                initialContexts[bundlerName].inject = context.inject;
                initialContexts[bundlerName].hook = context.hook;
                initialContexts[bundlerName].asyncHook = context.asyncHook;

                return [
                    {
                        name: 'custom-plugin',
                        buildStart() {
                            cwds[bundlerName] = context.cwd;
                        },
                    },
                ];
            },
        };

        const result = await runBundlers(pluginConfig);
        workingDir = result.workingDir;
    });

    describe('getContext', () => {
        describe.each(BUNDLERS)('[$name|$version]', ({ name, version }) => {
            test('Should have the right initial context.', () => {
                const context = initialContexts[name];
                expect(context).toBeDefined();
                expect(context.auth).toEqual(defaultPluginOptions.auth);
                expect(context.bundler.name).toBe(name.replace(context.bundler.variant || '', ''));
                expect(context.bundler.fullName).toBe(name);
                expect(BUNDLER_VERSIONS[name]).toBeTruthy();
                expect(BUNDLER_VERSIONS[name]).toEqual(expect.any(String));
                expect(context.bundler.version).toBe(BUNDLER_VERSIONS[name]);
                expect(context.cwd).toBe(process.cwd());
                expect(context.version).toBe(version);
                expect(context.inject).toEqual(expect.any(Function));
                expect(context.asyncHook).toEqual(expect.any(Function));
                expect(context.hook).toEqual(expect.any(Function));
                expect(context.plugins).toEqual(expect.any(Array));
                expect(context.pluginNames).toEqual(expect.any(Array));
            });

            test('Should update to the right CWD.', () => {
                expect(cwds[name]).toBe(workingDir);
            });
        });
    });

    describe('getLoggerFactory', () => {
        const setupLogger = (name: string): [Logger, BuildReport] => {
            const mockBuild = getMockBuild();
            const loggerFactory = getLoggerFactory(mockBuild, 'debug');
            const logger = loggerFactory(name);

            return [logger, mockBuild];
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

        const assessReport = (name: string, buildReport: BuildReport) => {
            expect(buildReport.logs).toHaveLength(4);
            const baseLog = {
                bundler: 'esbuild',
                pluginName: name,
                time: expect.any(Number),
            };
            expect(buildReport.logs[0]).toEqual({
                ...baseLog,
                type: 'error',
                message: 'An error occurred.',
            });
            expect(buildReport.logs[1]).toEqual({
                ...baseLog,
                type: 'warn',
                message: 'A warning message.',
            });
            expect(buildReport.logs[2]).toEqual({
                ...baseLog,
                type: 'info',
                message: 'An info message.',
            });
            expect(buildReport.logs[3]).toEqual({
                ...baseLog,
                type: 'debug',
                message: 'A debug message.',
            });

            expect(buildReport.errors).toEqual(['An error occurred.']);
            expect(buildReport.warnings).toEqual(['A warning message.']);
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
                const [logger, buildReport] = setupLogger('testLogger');
                useLogger(logger);

                assessReport('testLogger', buildReport);
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
                        },
                        {
                            start: expect.any(Number),
                            end: expect.any(Number),
                        },
                    ],
                    total: 300,
                    logLevel: 'debug',
                });
                expect(timing.spans[0].end! - timing.spans[0].start).toBe(100);
                expect(timing.spans[1].end! - timing.spans[1].start).toBe(200);
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
                const [logger, buildReport] = setupLogger('testLogger');
                const subLogger = logger.getLogger('subLogger');
                useLogger(subLogger);

                assessReport(`testLogger${NAME_SEP}subLogger`, buildReport);
            });
        });
    });
});
