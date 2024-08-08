// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, Options } from '@dd/core/types';
import { uploadSourcemaps } from '@dd/rum-plugins/sourcemaps/index';
import { getPlugins } from '@dd/telemetry-plugins';
import { defaultDestination, defaultEntry, defaultPluginOptions } from '@dd/tests/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/helpers/runBundlers';
import { getSourcemapsConfiguration } from '@dd/tests/plugins/rum/testHelpers';
import path from 'path';

jest.mock('@dd/telemetry-plugins', () => {
    const originalModule = jest.requireActual('@dd/telemetry-plugins');
    return {
        ...originalModule,
        getPlugins: jest.fn(() => []),
    };
});

jest.mock('@dd/rum-plugins/sourcemaps/index', () => {
    const originalModule = jest.requireActual('@dd/rum-plugins/sourcemaps/index');
    return {
        ...originalModule,
        uploadSourcemaps: jest.fn(),
    };
});

const getTelemetryPluginsMocked = jest.mocked(getPlugins);
const uploadSourcemapsMocked = jest.mocked(uploadSourcemaps);

describe('Global Context Plugin', () => {
    // Intercept contexts to verify it at the moment they're used.
    const initialContexts: Record<string, GlobalContext> = {};
    const lateContexts: Record<string, GlobalContext> = {};
    beforeAll(async () => {
        // This one is called at initialization, with the initial context.
        getTelemetryPluginsMocked.mockImplementation((options, context) => {
            const bundlerName = `${context.bundler.name}${context.bundler.variant || ''}`;
            initialContexts[bundlerName] = JSON.parse(JSON.stringify(context));
            return [];
        });

        // This one is called late in the build, with the final context.
        uploadSourcemapsMocked.mockImplementation((options, context, log) => {
            const bundlerName = `${context.bundler.name}${context.bundler.variant || ''}`;
            lateContexts[bundlerName] = JSON.parse(JSON.stringify(context));
            return Promise.resolve();
        });

        const pluginConfig: Options = {
            ...defaultPluginOptions,
            // TODO: Replace these with an injected custom plugins, once we implemented the feature.
            telemetry: {},
            rum: {
                sourcemaps: getSourcemapsConfiguration(),
            },
        };

        await runBundlers(pluginConfig);
    });

    test.each(BUNDLERS)('[$name|$version] Initial basic info.', ({ name, version }) => {
        const context = initialContexts[name];
        expect(context).toBeDefined();
        expect(context.auth).toEqual(defaultPluginOptions.auth);
        expect(context.bundler.name).toBe(name.replace(context.bundler.variant || '', ''));
        expect(context.cwd).toBe(process.cwd());
        expect(context.version).toBe(version);
    });

    test.each(BUNDLERS)('[$name|$version] Output directory.', ({ name }) => {
        const context = lateContexts[name];
        const outDir = context.bundler.outDir;

        const expectedOutDir = path.join(defaultDestination, name);

        expect(outDir).toEqual(expectedOutDir);
    });

    test.each(BUNDLERS)('[$name|$version] List of outputs.', ({ name }) => {
        const context = lateContexts[name];
        const outDir = context.bundler.outDir;

        expect(context.build.outputs).toBeDefined();
        expect(context.build.outputs).toHaveLength(2);

        expect(
            // Sort array to have deterministic results.
            context.build.outputs!.sort((a, b) => {
                if (a.name < b.name) {
                    return -1;
                }
                if (a.name > b.name) {
                    return 1;
                }
                return 0;
            }),
        ).toEqual([
            expect.objectContaining({
                name: `main.js`,
                filepath: `${outDir}/main.js`,
                size: expect.any(Number),
            }),
            expect.objectContaining({
                name: `main.js.map`,
                filepath: `${outDir}/main.js.map`,
                size: expect.any(Number),
            }),
        ]);
    });

    test.each(BUNDLERS)('[$name|$version] List of inputs.', ({ name }) => {
        const context = lateContexts[name];
        expect(context.build.inputs).toHaveLength(1);
        expect(context.build.inputs).toEqual([
            expect.objectContaining({
                name: `src/fixtures/index.js`,
                filepath: require.resolve(defaultEntry),
                size: 302,
            }),
        ]);
    });

    test.each(BUNDLERS)('[$name|$version] List of entries.', ({ name }) => {
        const context = lateContexts[name];
        expect(context.build.entries).toHaveLength(1);
        expect(context.build.entries).toEqual([
            expect.objectContaining({
                name: `src/fixtures/index.js`,
                filepath: require.resolve(defaultEntry),
                size: 302,
            }),
        ]);
    });
});
