// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options, GlobalContext } from '@dd/core/types';
import { BUNDLER_VERSIONS } from '@dd/tests/_jest/helpers/constants';
import { cleanEnv } from '@dd/tests/_jest/helpers/env';
import { defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';

describe('Factory Helpers', () => {
    // Intercept contexts to verify it at the moment they're used.
    const initialContexts: Record<string, GlobalContext> = {};
    const buildRoots: Record<string, string> = {};
    let workingDir: string;
    let restoreEnv: () => void;

    beforeAll(async () => {
        const pluginConfig: Options = {
            ...defaultPluginOptions,
            // Use a custom plugin to intercept contexts to verify it at initialization.
            customPlugins: ({ context }) => {
                const bundlerName = context.bundler.name;
                initialContexts[bundlerName] = JSON.parse(JSON.stringify(context));

                // These are functions, so they can't be serialized with parse/stringify.
                initialContexts[bundlerName].inject = context.inject;
                initialContexts[bundlerName].hook = context.hook;
                initialContexts[bundlerName].asyncHook = context.asyncHook;
                // Need to individually copy, because 'apiKey' and 'appKey' a non enumerable.
                initialContexts[bundlerName].auth = context.auth;

                return [
                    {
                        name: 'custom-plugin',
                        buildRoot(buildRoot) {
                            buildRoots[bundlerName] = buildRoot;
                        },
                    },
                ];
            },
        };

        restoreEnv = cleanEnv();
        const result = await runBundlers(pluginConfig);
        workingDir = result.workingDir;
    });

    afterAll(() => {
        restoreEnv();
    });

    describe('getContext', () => {
        describe.each(BUNDLERS)('[$name|$version]', ({ name, version }) => {
            test('Should have the right initial context.', () => {
                const context = initialContexts[name];
                expect(context).toBeDefined();
                // Need to individually test, because 'apiKey' and 'appKey' a non enumerable.
                expect(context.auth.apiKey).toEqual(defaultPluginOptions.auth.apiKey);
                expect(context.auth.appKey).toEqual(defaultPluginOptions.auth.appKey);
                expect(context.auth.site).toEqual(defaultPluginOptions.auth.site);
                expect(context.bundler.name).toBe(name);
                expect(BUNDLER_VERSIONS[name]).toBeTruthy();
                expect(BUNDLER_VERSIONS[name]).toEqual(expect.any(String));
                expect(context.bundler.version).toBe(BUNDLER_VERSIONS[name]);
                expect(context.buildRoot).toBe(process.cwd());
                expect(context.version).toBe(version);
                expect(context.inject).toEqual(expect.any(Function));
                expect(context.asyncHook).toEqual(expect.any(Function));
                expect(context.hook).toEqual(expect.any(Function));
                expect(context.plugins).toEqual(expect.any(Array));
                expect(context.pluginNames).toEqual(expect.any(Array));
            });

            test('Should update to the right buildRoot.', () => {
                expect(buildRoots[name]).toBe(workingDir);
            });
        });
    });
});
