// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BuildReport, GlobalContext, Logger, Options, ToInjectItem } from '@dd/core/types';
import { getContext, getLoggerFactory } from '@dd/factory/helpers';
import { BUNDLER_VERSIONS } from '@dd/tests/_jest/helpers/constants';
import { defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import type { CleanupFn } from '@dd/tests/_jest/helpers/types';
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

describe('Factory Helpers', () => {
    // Intercept contexts to verify it at the moment they're used.
    const initialContexts: Record<string, GlobalContext> = {};
    let cleanup: CleanupFn;

    beforeAll(async () => {
        const pluginConfig: Options = {
            ...defaultPluginOptions,
            // Use a custom plugin to intercept contexts to verify it at initialization.
            customPlugins: (opts, context) => {
                const bundlerName = context.bundler.fullName;
                initialContexts[bundlerName] = JSON.parse(JSON.stringify(context));

                // These are functions, so they can't be serialized with parse/stringify.
                initialContexts[bundlerName].inject = context.inject;

                return [];
            },
        };

        cleanup = await runBundlers(pluginConfig);
    });

    afterAll(async () => {
        await cleanup();
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
            });
        });

        test('Should inject items for the injection plugin.', () => {
            const injections: ToInjectItem[] = [];
            const context = getContext({
                options: defaultPluginOptions,
                bundlerName: 'webpack',
                bundlerVersion: '1.0.0',
                injections,
                version: '1.0.0',
            });
            const injectedItem: ToInjectItem = { type: 'code', value: 'injected' };
            context.inject(injectedItem);
            expect(injections).toEqual([injectedItem]);
        });
    });

    describe('getLoggerFactory', () => {
        const setupLogger = (): [Logger, BuildReport] => {
            const mockBuild = { errors: [], warnings: [], logs: [] };
            const loggerFactory = getLoggerFactory(mockBuild, 'debug');
            const logger = loggerFactory('testLogger');

            return [logger, mockBuild];
        };

        const useLogger = (logger: Logger) => {
            logger.error('An error occurred.');
            logger.warn('A warning message.');
            logger.info('An info message.');
            logger.debug('A debug message.');
        };

        test('Should return a logger factory.', () => {
            const [logger] = setupLogger();

            expect(logger.error).toEqual(expect.any(Function));
            expect(logger.warn).toEqual(expect.any(Function));
            expect(logger.info).toEqual(expect.any(Function));
            expect(logger.debug).toEqual(expect.any(Function));
        });

        test('Should log as expected', () => {
            const [logger] = setupLogger();
            useLogger(logger);

            // Access logs and strip colors.
            const getOutput = (mock: jest.Mock, index: number) =>
                stripAnsi(mock.mock.calls[index][0]);

            expect(logMock).toHaveBeenCalledTimes(2);
            expect(getOutput(logMock, 0)).toBe('[info|testLogger] An info message.');
            expect(getOutput(logMock, 1)).toBe('[debug|testLogger] A debug message.');

            expect(errorMock).toHaveBeenCalledTimes(1);
            expect(getOutput(errorMock, 0)).toBe('[error|testLogger] An error occurred.');

            expect(warnMock).toHaveBeenCalledTimes(1);
            expect(getOutput(warnMock, 0)).toBe('[warn|testLogger] A warning message.');
        });

        test('Should store logs as expected.', () => {
            const [logger, buildReport] = setupLogger();
            useLogger(logger);

            expect(buildReport.logs).toHaveLength(4);
            expect(buildReport.logs[0]).toEqual({
                pluginName: 'testLogger',
                type: 'error',
                message: 'An error occurred.',
                time: expect.any(Number),
            });
            expect(buildReport.logs[1]).toEqual({
                pluginName: 'testLogger',
                type: 'warn',
                message: 'A warning message.',
                time: expect.any(Number),
            });
            expect(buildReport.logs[2]).toEqual({
                pluginName: 'testLogger',
                type: 'info',
                message: 'An info message.',
                time: expect.any(Number),
            });
            expect(buildReport.logs[3]).toEqual({
                pluginName: 'testLogger',
                type: 'debug',
                message: 'A debug message.',
                time: expect.any(Number),
            });

            expect(buildReport.errors).toEqual(['An error occurred.']);
            expect(buildReport.warnings).toEqual(['A warning message.']);
        });
    });
});
