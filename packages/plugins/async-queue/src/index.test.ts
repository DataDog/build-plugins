// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';

jest.mock('@dd/factory/helpers/logger', () => {
    const actual = jest.requireActual('@dd/factory/helpers/logger');
    const actualGetLoggerFactory = actual.getLoggerFactory;
    return {
        ...actual,
        getLoggerFactory: jest.fn((...args) => {
            const loggerFactory = actualGetLoggerFactory(...args);
            return jest.fn((name) => {
                const logger = loggerFactory(name);
                logger.error = mockLogFn;
                return logger;
            });
        }),
    };
});

describe('Async Queue Plugin', () => {
    test('Should wait for all promises in the queue', async () => {
        const mockFn = jest.fn().mockResolvedValue('success');
        await runBundlers({
            logLevel: 'none',
            customPlugins: ({ context }) => {
                return [
                    {
                        name: 'test-plugin',
                        buildStart: () => {
                            // Add promises to the queue
                            context.queue(mockFn(context.bundler.fullName));
                        },
                    },
                ];
            },
        });

        expect(mockFn).toHaveBeenCalledTimes(BUNDLERS.length);
        for (const { name } of BUNDLERS) {
            expect(mockFn).toHaveBeenCalledWith(name);
        }
    });

    test('Should handle errors in queued promises gracefully', async () => {
        const mockFn = jest.fn().mockRejectedValue(new Error('Test error'));
        await runBundlers({
            logLevel: 'error',
            customPlugins: ({ context }) => {
                return [
                    {
                        name: 'test-plugin',
                        buildStart: () => {
                            // Add failing promise to the queue
                            context.queue(mockFn(context.bundler.fullName));
                        },
                    },
                ];
            },
        });

        // The error should have been logged
        expect(mockLogFn).toHaveBeenCalledTimes(BUNDLERS.length);
        expect(mockLogFn).toHaveBeenCalledWith(
            expect.stringContaining(`Error occurred while processing async queue`),
        );
    });
});
