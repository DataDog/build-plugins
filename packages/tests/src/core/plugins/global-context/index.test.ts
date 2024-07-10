// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options } from '@dd/core/types';
import { uploadSourcemaps } from '@dd/rum-plugins/sourcemaps/index';
import { getPlugins } from '@dd/telemetry-plugins';
import { BUNDLERS, defaultDestination, defaultPluginOptions } from '@dd/tests/helpers/mocks';
import { runBundlers } from '@dd/tests/helpers/runBundlers';
import { rmSync } from 'fs';

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
    beforeEach(() => {
        rmSync(defaultDestination, { recursive: true, force: true });
    });

    test('It should inject context in the other plugins.', async () => {
        const pluginConfig = {
            ...defaultPluginOptions,
            telemetry: {},
        };

        await runBundlers(pluginConfig);

        // Confirm every call shares the options and the global context
        for (const call of getPluginsMocked.mock.calls) {
            expect(call[0]).toEqual(pluginConfig);
            expect(call[1]).toEqual({
                auth: expect.objectContaining({
                    apiKey: expect.any(String),
                }),
                bundler: {
                    name: expect.any(String),
                    config: expect.any(Object),
                },
                cwd: expect.any(String),
                outputDir: expect.any(String),
                outputFiles: expect.any(Array),
                version: expect.any(String),
            });
        }
    });

    test('It should give the list of files produced by the build', async () => {
        const pluginConfig: Options = {
            ...defaultPluginOptions,
            rum: {
                sourcemaps: {
                    basePath: 'base-path',
                    minifiedPathPrefix: 'http://path',
                    releaseVersion: '1.0.0',
                    service: 'service',
                },
            },
        };

        await runBundlers(pluginConfig);

        // This will fail when we add new bundlers to support.
        // It is intended so we keep an eye on it whenever we add a new bundler.
        expect(uploadSourcemapsMocked).toHaveBeenCalledTimes(BUNDLERS.length);
        for (const call of uploadSourcemapsMocked.mock.calls) {
            expect(call[1]).toMatchObject({
                outputFiles: expect.arrayContaining([
                    {
                        filepath: expect.stringMatching(
                            new RegExp(`^${defaultDestination}/(${BUNDLERS.join('|')})/main.js$`),
                        ),
                    },
                    {
                        filepath: expect.stringMatching(
                            new RegExp(
                                `^${defaultDestination}/(${BUNDLERS.join('|')})/main.js.map$`,
                            ),
                        ),
                    },
                ]),
            });
        }
    });
});
