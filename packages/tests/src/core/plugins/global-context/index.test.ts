// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, Options } from '@dd/core/types';
import { uploadSourcemaps } from '@dd/rum-plugins/sourcemaps/index';
import { getPlugins } from '@dd/telemetry-plugins';
import { defaultDestination, defaultPluginOptions } from '@dd/tests/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/helpers/runBundlers';

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

const getPluginsMocked = jest.mocked(getPlugins);
const uploadSourcemapsMocked = jest.mocked(uploadSourcemaps);

describe('Global Context Plugin', () => {
    test('It should inject context in the other plugins.', async () => {
        // Intercept context to verify it at the moment it's sent.
        const contextResults: GlobalContext[] = [];
        getPluginsMocked.mockImplementation((options, context) => {
            // We remove git for better readability.
            contextResults.push({ ...context, git: undefined });
            return [];
        });

        const pluginConfig = {
            ...defaultPluginOptions,
            telemetry: {},
        };

        await runBundlers(pluginConfig);

        expect(contextResults).toHaveLength(BUNDLERS.length);
        for (const context of contextResults) {
            expect(context).toEqual({
                auth: expect.objectContaining({
                    apiKey: expect.any(String),
                }),
                bundler: {
                    name: expect.any(String),
                    rawConfig: expect.any(Object),
                },
                cwd: expect.any(String),
                outputDir: expect.any(String),
                version: expect.any(String),
            });
        }
    });

    test('It should give the list of files produced by the build', async () => {
        // Intercept context to verify it at the moment it's sent.
        const contextResults: GlobalContext[] = [];
        uploadSourcemapsMocked.mockImplementation((options, context, log) => {
            // We remove git for better readability.
            contextResults.push({ ...context, git: undefined });
            return Promise.resolve();
        });

        const pluginConfig: Options = {
            ...defaultPluginOptions,
            rum: {
                sourcemaps: {
                    minifiedPathPrefix: 'http://path',
                    releaseVersion: '1.0.0',
                    service: 'service',
                },
            },
        };

        await runBundlers(pluginConfig);

        expect(contextResults).toHaveLength(BUNDLERS.length);
        for (const context of contextResults) {
            expect(context.outputFiles).toBeDefined();
            expect(context.outputFiles).toHaveLength(2);

            let matchedFile = false;
            let matchedSourcemap = false;

            for (const file of context.outputFiles!) {
                const bundlersNames = BUNDLERS.map((bundler) => bundler.name).join('|');
                if (
                    file.filepath.match(
                        new RegExp(`^${defaultDestination}/(${bundlersNames})/main.js$`),
                    )
                ) {
                    matchedFile = true;
                } else if (
                    file.filepath.match(
                        new RegExp(`^${defaultDestination}/(${bundlersNames})/main.js.map$`),
                    )
                ) {
                    matchedSourcemap = true;
                }
            }

            expect(matchedFile).toBe(true);
            expect(matchedSourcemap).toBe(true);
        }
    });
});
