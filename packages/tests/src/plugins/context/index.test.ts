// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, Options } from '@dd/core/types';
import { BUNDLER_VERSIONS } from '@dd/tests/helpers/constants';
import { defaultPluginOptions } from '@dd/tests/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/helpers/runBundlers';
import type { CleanupFn } from '@dd/tests/helpers/types';

describe('Global Context', () => {
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
                return [];
            },
        };

        cleanup = await runBundlers(pluginConfig);
    });

    afterAll(async () => {
        await cleanup();
    });

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
        });
    });
});
