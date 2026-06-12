// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';

describe('True End', () => {
    // TODO test for multi outputs, failing builds, async hook in esbuild.
    test('Should call true end hook.', async () => {
        const asyncBundlers: string[] = [];
        const calls: string[] = [];
        const flushBundlers: string[] = [];
        const syncBundlers: string[] = [];

        const asyncTrueEndHookFn = jest.fn(async (bundler: string) => {
            calls.push(`${bundler}:asyncTrueEnd`);
            asyncBundlers.push(bundler);
        });
        const flushHookFn = jest.fn(async (bundler: string) => {
            calls.push(`${bundler}:flush`);
            flushBundlers.push(bundler);
        });
        const syncTrueEndHookFn = jest.fn((bundler: string) => {
            calls.push(`${bundler}:syncTrueEnd`);
            syncBundlers.push(bundler);
        });

        await runBundlers({
            logLevel: 'none',
            customPlugins: ({ context }) => {
                return [
                    {
                        name: 'true-end-plugin',
                        async asyncTrueEnd() {
                            await asyncTrueEndHookFn(context.bundler.name);
                        },
                        async flush() {
                            await flushHookFn(context.bundler.name);
                        },
                        syncTrueEnd() {
                            syncTrueEndHookFn(context.bundler.name);
                        },
                    },
                ];
            },
        });

        const bundlerNames = BUNDLERS.map((b) => b.name);

        expect(asyncBundlers).toEqual(bundlerNames);
        expect(flushBundlers).toEqual(bundlerNames);
        expect(syncBundlers).toEqual(bundlerNames);

        expect(asyncTrueEndHookFn).toHaveBeenCalledTimes(BUNDLERS.length);
        expect(flushHookFn).toHaveBeenCalledTimes(BUNDLERS.length);
        expect(syncTrueEndHookFn).toHaveBeenCalledTimes(BUNDLERS.length);

        for (const bundlerName of bundlerNames) {
            const syncIndex = calls.indexOf(`${bundlerName}:syncTrueEnd`);
            const asyncIndex = calls.indexOf(`${bundlerName}:asyncTrueEnd`);
            const flushIndex = calls.indexOf(`${bundlerName}:flush`);

            expect(syncIndex).toBeGreaterThanOrEqual(0);
            expect(flushIndex).toBeGreaterThan(asyncIndex);

            // esbuild runs syncTrueEnd from onDispose, so it cannot share this async ordering.
            /* eslint-disable jest/no-conditional-expect */
            if (bundlerName !== 'esbuild') {
                expect(asyncIndex).toBeGreaterThan(syncIndex);
                expect(flushIndex).toBeGreaterThan(syncIndex);
            }
            /* eslint-enable jest/no-conditional-expect */
        }
    });
});
