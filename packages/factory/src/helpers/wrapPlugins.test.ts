// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginOptions } from '@dd/core/types';
import {
    getGetPluginsArg,
    getContextMock,
    getMockData,
    getMockStores,
} from '@dd/tests/_jest/helpers/mocks';

import { getLoggerFactory } from './logger';
import { wrapGetPlugins, wrapHook, wrapPlugin } from './wrapPlugins';

const wait = (duration: number) => new Promise((resolve) => setTimeout(resolve, duration));
describe('profilePlugins', () => {
    describe('wrapGetPlugins', () => {
        const logger = getLoggerFactory(getMockData(), getMockStores())('fake-logger');
        const timer = logger.time('fake-timer');
        jest.spyOn(timer, 'end');
        jest.spyOn(logger, 'time').mockReturnValue(timer);

        test('Should wrap the getPlugins function and measure initialization time', () => {
            const mockContext = getContextMock();
            const mockGetPlugins = jest.fn(() => {
                return [
                    {
                        name: 'datadog-test-1-plugin',
                    },
                    {
                        name: 'datadog-test-2-plugin',
                    },
                ];
            });
            jest.spyOn(mockContext, 'getLogger').mockReturnValue(logger);

            const wrappedGetPlugins = wrapGetPlugins(mockContext, mockGetPlugins, 'test-plugins');
            const pluginsArg = getGetPluginsArg();
            const result = wrappedGetPlugins(pluginsArg);

            // Verify getPlugins was called with the right arguments
            expect(mockGetPlugins).toHaveBeenCalledWith(pluginsArg);

            // Verify timer was started and ended
            expect(logger.time).toHaveBeenCalledWith(
                'hook | init test-plugins',
                expect.any(Object),
            );
            expect(timer.end).toHaveBeenCalledTimes(1);

            // Verify the timer got tagged with the plugin names.
            expect(timer.timer.tags).toContain('plugin:datadog-test-1-plugin');
            expect(timer.timer.tags).toContain('plugin:datadog-test-2-plugin');

            // Verify the result contains the expected plugins
            expect(result).toHaveLength(2);
            expect(result[0].name).toBe('datadog-test-1-plugin');
            expect(result[1].name).toBe('datadog-test-2-plugin');
        });
    });

    describe('wrapPlugin', () => {
        const logger = getLoggerFactory(getMockData(), getMockStores())('fake-logger');
        const mockPlugin: PluginOptions = {
            name: 'datadog-test-1-plugin',
            buildStart: jest.fn(),
            resolveId: jest.fn(),
        };

        test("Should wrap the plugin's hooks.", async () => {
            const plugin = wrapPlugin(mockPlugin, logger);

            // Verify hooks are wrapped.
            expect(plugin.buildStart).toBeDefined();
            expect(plugin.resolveId).toBeDefined();
            expect(plugin.buildStart).not.toBe(mockPlugin.buildStart);
            expect(plugin.resolveId).not.toBe(mockPlugin.resolveId);
        });
    });

    describe('wrapHook', () => {
        const logger = getLoggerFactory(getMockData(), getMockStores())('fake-logger');
        const timer = logger.time('fake-timer');
        jest.spyOn(timer, 'end');
        jest.spyOn(logger, 'time').mockReturnValue(timer);

        const mockPlugin: PluginOptions = {
            name: 'datadog-test-1-plugin',
            transform: jest.fn(async () => {
                await wait(500);
                return 'transform';
            }),
            resolveId: jest.fn(async () => {
                await wait(500);
                throw new Error('resolveId');
            }),
        };

        beforeAll(() => {
            jest.useFakeTimers();
        });

        afterAll(() => {
            jest.useRealTimers();
        });

        test('Should wrap the hook and measure time.', async () => {
            const wrappedHook = wrapHook(
                mockPlugin.name,
                'buildStart',
                mockPlugin.transform!,
                logger,
            );

            const prom = wrappedHook();
            jest.advanceTimersByTime(500);
            const result = await prom;

            expect(timer.end).toHaveBeenCalledTimes(1);
            expect(timer.timer.total).toBeGreaterThan(500);
            expect(result).toBe('transform');
        });

        test('Should still measure a throwing hook.', async () => {
            const wrappedHook = wrapHook(
                mockPlugin.name,
                'buildStart',
                mockPlugin.resolveId!,
                logger,
            );

            const prom = wrappedHook();
            jest.advanceTimersByTime(500);

            await expect(prom).rejects.toThrow('resolveId');
            expect(timer.end).toHaveBeenCalledTimes(1);
            expect(timer.timer.total).toBeGreaterThan(500);
        });
    });
});
