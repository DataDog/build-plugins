// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BundlerFullName, CustomHooks, GlobalContext } from '@dd/core/types';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';

describe('Custom hooks', () => {
    test('Should call the fake hook.', async () => {
        const fakeHookFn = jest.fn();
        const fakeAsyncHookFn = jest.fn();
        const errors: Partial<Record<BundlerFullName, string[]>> = {};
        const contexts: Partial<Record<BundlerFullName, GlobalContext>> = {};
        const cleanup = await runBundlers({
            logLevel: 'none',
            customPlugins: (opts, context) => {
                const buildErrors: string[] = [];
                errors[context.bundler.fullName] = buildErrors;
                contexts[context.bundler.fullName] = context;
                return [
                    {
                        name: 'custom-test-hook-plugin',
                        async failingHookTest() {
                            // Should trigger an error because it's async.
                        },
                        async asyncHookTest(bundlerName: string) {
                            fakeAsyncHookFn(bundlerName);
                        },
                        hookTest(bundlerName: string) {
                            fakeHookFn(bundlerName);
                        },
                    },
                    {
                        name: 'custom-test-hook-caller-plugin',
                        async buildStart() {
                            const hookTest: keyof CustomHooks = 'hookTest' as keyof CustomHooks;
                            const asyncHookTest: keyof CustomHooks =
                                'asyncHookTest' as keyof CustomHooks;
                            const failingHookTest: keyof CustomHooks =
                                'failingHookTest' as keyof CustomHooks;

                            context.hook(hookTest, context.bundler.fullName);

                            try {
                                context.hook(failingHookTest, context.bundler.fullName);
                            } catch (e: any) {
                                buildErrors.push(e.message);
                            }

                            await context.asyncHook(asyncHookTest, context.bundler.fullName);
                        },
                    },
                ];
            },
        });

        expect(fakeHookFn).toHaveBeenCalledTimes(BUNDLERS.length);
        expect(fakeAsyncHookFn).toHaveBeenCalledTimes(BUNDLERS.length);

        for (const { name } of BUNDLERS) {
            const buildErrors = errors[name]!;
            const ctx = contexts[name]!;

            expect(fakeHookFn).toHaveBeenCalledWith(name);
            expect(fakeAsyncHookFn).toHaveBeenCalledWith(name);

            // It should also have detected async errors.
            expect(buildErrors).toEqual(['Some plugins errored during the hook execution.']);
            expect(ctx.build.errors).toEqual([
                'Plugin "custom-test-hook-plugin" returned a promise on the non async hook "failingHookTest".',
            ]);
        }

        await cleanup();
    });
});
