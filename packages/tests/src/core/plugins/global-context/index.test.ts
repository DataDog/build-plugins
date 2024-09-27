// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, Options } from '@dd/core/types';
import { defaultPluginOptions } from '@dd/tests/helpers/mocks';
import type { CleanupFn } from '@dd/tests/helpers/runBundlers';
import { BUNDLERS, runBundlers } from '@dd/tests/helpers/runBundlers';

describe('Global Context Plugin', () => {
    // Intercept contexts to verify it at the moment they're used.
    const initialContexts: Record<string, GlobalContext> = {};
    const lateContexts: Record<string, GlobalContext> = {};
    let cleanup: CleanupFn;

    beforeAll(async () => {
        const pluginConfig: Options = {
            ...defaultPluginOptions,
            // Use a custom plugin to intercept contexts to verify it at the moment they're used.
            customPlugins: (opts, context) => {
                const bundlerName = context.bundler.fullName;
                initialContexts[bundlerName] = JSON.parse(JSON.stringify(context));
                return [
                    {
                        name: 'custom-plugin',
                        writeBundle() {
                            lateContexts[bundlerName] = JSON.parse(JSON.stringify(context));
                        },
                    },
                ];
            },
        };

        cleanup = await runBundlers(pluginConfig);
    });

    afterAll(async () => {
        await cleanup();
    });

    test.each(BUNDLERS)('[$name|$version] Initial basic info.', ({ name, version }) => {
        const context = initialContexts[name];
        expect(context).toBeDefined();
        expect(context.auth).toEqual(defaultPluginOptions.auth);
        expect(context.bundler.name).toBe(name.replace(context.bundler.variant || '', ''));
        expect(context.bundler.fullName).toBe(context.bundler.name + context.bundler.variant);
        expect(context.cwd).toBe(process.cwd());
        expect(context.version).toBe(version);
    });
});
