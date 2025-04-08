// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginOptions } from '@dd/core/types';
import {
    getGetPluginsArg,
    getContextMock,
    getMockTimer,
    getMockLogger,
} from '@dd/tests/_jest/helpers/mocks';

import { wrapGetPlugins, wrapHook, wrapPlugin } from './wrapPlugins';

const wait = (duration: number) => new Promise((resolve) => setTimeout(resolve, duration));
describe('profilePlugins', () => {
    describe('wrapGetPlugins', () => {
        const mockTimer = getMockTimer();
        const mockLogger = getMockLogger({
            time: jest.fn(() => mockTimer),
        });
        const mockContext = getContextMock({
            getLogger: jest.fn(() => mockLogger),
        });
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

        test('Should wrap the getPlugins function and measure initialization time', () => {
            const wrappedGetPlugins = wrapGetPlugins(mockContext, mockGetPlugins, 'test-plugins');
            const pluginsArg = getGetPluginsArg();
            const result = wrappedGetPlugins(pluginsArg);

            // Verify getPlugins was called with the right arguments
            expect(mockGetPlugins).toHaveBeenCalledWith(pluginsArg);

            // Verify timer was started and ended
            expect(mockLogger.time).toHaveBeenCalledWith(
                'hook | init test-plugins',
                expect.any(Object),
            );
            expect(mockTimer.end).toHaveBeenCalledTimes(1);

            // Verify the timer got tagged with the plugin names.
            expect(mockTimer.timer.tags).toEqual([
                'plugin:datadog-test-1-plugin',
                'plugin:datadog-test-2-plugin',
            ]);

            // Verify the result contains the expected plugins
            expect(result).toHaveLength(2);
            expect(result[0].name).toBe('datadog-test-1-plugin');
            expect(result[1].name).toBe('datadog-test-2-plugin');
        });
    });

    describe('wrapPlugin', () => {
        const mockTimer = getMockTimer();
        const mockLogger = getMockLogger({
            time: jest.fn(() => mockTimer),
        });
        const mockPlugin: PluginOptions = {
            name: 'datadog-test-1-plugin',
            buildStart: jest.fn(),
            resolveId: jest.fn(),
        };

        beforeAll(() => {
            jest.useFakeTimers();
        });

        afterAll(() => {
            jest.useRealTimers();
        });

        test("Should wrap the plugin's hooks.", async () => {
            const plugin = wrapPlugin(mockPlugin, mockLogger);

            // Verify hooks are wrapped.
            expect(plugin.buildStart).toBeDefined();
            expect(plugin.resolveId).toBeDefined();
            expect(plugin.buildStart).not.toBe(mockPlugin.buildStart);
            expect(plugin.resolveId).not.toBe(mockPlugin.resolveId);
        });
    });

    describe('wrapHook', () => {
        const mockTimer = getMockTimer();
        const mockLogger = getMockLogger({
            time: jest.fn(() => mockTimer),
        });

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
                mockLogger,
            );

            const prom = wrappedHook();
            jest.advanceTimersByTime(500);
            const result = await prom;

            expect(mockTimer.end).toHaveBeenCalledTimes(1);
            expect(mockTimer.timer.total).toBeGreaterThan(500);
            expect(result).toBe('transform');
        });

        test('Should still measure a throwing hook.', async () => {
            const wrappedHook = wrapHook(
                mockPlugin.name,
                'buildStart',
                mockPlugin.resolveId!,
                mockLogger,
            );

            const prom = wrappedHook();
            jest.advanceTimersByTime(500);

            await expect(prom).rejects.toThrow('resolveId');
            expect(mockTimer.end).toHaveBeenCalledTimes(1);
            expect(mockTimer.timer.total).toBeGreaterThan(500);
        });
    });
});
