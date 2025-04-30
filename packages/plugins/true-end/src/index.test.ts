// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';

describe('True End', () => {
    // TODO test for multi outputs, failing builds, async hook in esbuild.
    test('Should call true end hook.', async () => {
        const asyncBundlers: string[] = [];
        const syncBundlers: string[] = [];

        const asyncTrueEndHookFn = jest.fn(async (bundler: string) => {
            asyncBundlers.push(bundler);
        });
        const syncTrueEndHookFn = jest.fn((bundler: string) => {
            syncBundlers.push(bundler);
        });

        await runBundlers({
            logLevel: 'none',
            customPlugins: ({ context }) => {
                return [
                    {
                        name: 'true-end-plugin',
                        async asyncTrueEnd() {
                            await asyncTrueEndHookFn(context.bundler.fullName);
                        },
                        syncTrueEnd() {
                            syncTrueEndHookFn(context.bundler.fullName);
                        },
                    },
                ];
            },
        });

        const bundlerNames = BUNDLERS.map((b) => b.name);

        expect(asyncTrueEndHookFn).toHaveBeenCalledTimes(BUNDLERS.length);
        expect(syncTrueEndHookFn).toHaveBeenCalledTimes(BUNDLERS.length);

        expect(asyncBundlers).toEqual(bundlerNames);
        expect(syncBundlers).toEqual(bundlerNames);
    });
});
