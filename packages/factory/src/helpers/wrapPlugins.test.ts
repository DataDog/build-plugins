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

        beforeAll(() => {
            jest.useFakeTimers();
        });

        afterAll(() => {
            jest.useRealTimers();
        });

        describe('Function hooks', () => {
            test('Should wrap a function hook and measure time', async () => {
                const mockTransform = jest.fn(async (code: string) => {
                    await wait(500);
                    return { code: `${code}-transformed`, map: null };
                });

                const wrappedHook = wrapHook('test-plugin', 'transform', mockTransform, logger);

                const prom = wrappedHook('const a = 1');
                jest.advanceTimersByTime(500);
                const result = await prom;

                expect(mockTransform).toHaveBeenCalledWith('const a = 1');
                expect(timer.end).toHaveBeenCalledTimes(1);
                expect(timer.timer.total).toBeGreaterThan(500);
                expect(result).toEqual({ code: 'const a = 1-transformed', map: null });
            });

            test('Should handle synchronous function hooks', () => {
                const mockResolveId = jest.fn((id: string) => {
                    return id.startsWith('./') ? `/resolved${id}` : null;
                });

                const wrappedHook = wrapHook('test-plugin', 'resolveId', mockResolveId, logger);

                const result = wrappedHook('./test.ts');

                expect(mockResolveId).toHaveBeenCalledWith('./test.ts');
                expect(timer.end).toHaveBeenCalledTimes(1);
                expect(result).toBe('/resolved./test.ts');
            });

            test('Should measure time for throwing hooks', async () => {
                const mockBuildStart = jest.fn(async () => {
                    await wait(500);
                    throw new Error('Build failed');
                });

                const wrappedHook = wrapHook('test-plugin', 'buildStart', mockBuildStart, logger);

                const prom = wrappedHook();
                jest.advanceTimersByTime(500);

                await expect(prom).rejects.toThrow('Build failed');
                expect(timer.end).toHaveBeenCalledTimes(1);
                expect(timer.timer.total).toBeGreaterThan(500);
            });
        });

        describe('Object hooks', () => {
            test('Should wrap transform hook with filter object', async () => {
                const mockHandler = jest.fn(async (code: string) => {
                    await wait(300);
                    return { code: `${code}-filtered`, map: null };
                });

                const transformHook = {
                    filter: {
                        id: {
                            include: ['**/*.ts', '**/*.tsx'],
                            exclude: ['node_modules/**'],
                        },
                    },
                    handler: mockHandler,
                };

                const wrappedHook = wrapHook('test-plugin', 'transform', transformHook, logger);

                // Verify the filter is preserved
                expect(wrappedHook.filter).toEqual(transformHook.filter);

                // Test the wrapped handler
                const prom = wrappedHook.handler('const a = 1');
                jest.advanceTimersByTime(300);
                const result = await prom;

                expect(mockHandler).toHaveBeenCalledWith('const a = 1');
                expect(timer.end).toHaveBeenCalledTimes(1);
                expect(timer.timer.total).toBeGreaterThan(300);
                expect(result).toEqual({ code: 'const a = 1-filtered', map: null });
            });

            test('Should wrap load hook with RegExp filter', async () => {
                const mockHandler = jest.fn(async (id: string) => {
                    await wait(200);
                    return { code: `export default "${id}"` };
                });

                const loadHook = {
                    filter: {
                        id: /\.virtual$/,
                    },
                    handler: mockHandler,
                };

                const wrappedHook = wrapHook('test-plugin', 'load', loadHook, logger);

                // Verify the filter is preserved
                expect(wrappedHook.filter).toEqual(loadHook.filter);

                // Test the wrapped handler
                const prom = wrappedHook.handler('/src/test.virtual');
                jest.advanceTimersByTime(200);
                const result = await prom;

                expect(mockHandler).toHaveBeenCalledWith('/src/test.virtual');
                expect(timer.end).toHaveBeenCalledTimes(1);
                expect(timer.timer.total).toBeGreaterThan(200);
                expect(result).toEqual({ code: 'export default "/src/test.virtual"' });
            });

            test('Should handle synchronous object hook handlers', () => {
                const mockHandler = jest.fn((code: string) => {
                    return code.toUpperCase();
                });

                const transformHook = {
                    filter: {
                        id: '*.css',
                    },
                    handler: mockHandler,
                };

                const wrappedHook = wrapHook('test-plugin', 'transform', transformHook, logger);

                const result = wrappedHook.handler('body { color: red; }');

                expect(mockHandler).toHaveBeenCalledWith('body { color: red; }');
                expect(timer.end).toHaveBeenCalledTimes(1);
                expect(result).toBe('BODY { COLOR: RED; }');
            });

            test('Should preserve all properties of object hooks', () => {
                const transformHook = {
                    filter: {
                        id: {
                            include: ['**/*.vue'],
                            exclude: ['**/*.test.vue'],
                        },
                    },
                    handler: jest.fn((code: string) => code),
                    enforce: 'pre',
                    // Custom property that might be used by the bundler
                    customOption: true,
                };

                const wrappedHook = wrapHook('test-plugin', 'transform', transformHook, logger);

                // All properties should be preserved
                expect(wrappedHook.filter).toEqual(transformHook.filter);
                expect(wrappedHook.enforce).toBe('pre');
                expect((wrappedHook as any).customOption).toBe(true);
                expect(wrappedHook.handler).not.toBe(transformHook.handler); // Handler should be wrapped
            });
        });

        describe('Edge cases', () => {
            test('Should handle hooks that return void', () => {
                const mockBuildEnd = jest.fn(() => {
                    // Side effect only, no return value
                });

                const wrappedHook = wrapHook('test-plugin', 'buildEnd', mockBuildEnd, logger);

                const result = wrappedHook();

                expect(mockBuildEnd).toHaveBeenCalled();
                expect(timer.end).toHaveBeenCalledTimes(1);
                expect(result).toBeUndefined();
            });

            test('Should preserve "this" context for hooks', async () => {
                let capturedThis: any;
                const mockTransform = jest.fn(function (this: any, code: string) {
                    capturedThis = this;
                    return { code: `${code}-modified` };
                });

                const wrappedHook = wrapHook('test-plugin', 'transform', mockTransform, logger);

                const mockContext = { addWatchFile: jest.fn() };
                const result = wrappedHook.call(mockContext, 'const a = 1');

                expect(capturedThis).toBe(mockContext);
                expect(result).toEqual({ code: 'const a = 1-modified' });
            });
        });
    });
});
