// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogRspackPlugin } from '@datadog/rspack-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { rm } from '@dd/core/helpers/fs';
import { getUniqueId } from '@dd/core/helpers/strings';
import type { BundlerFullName, Options } from '@dd/core/types';
import { prepareWorkingDir } from '@dd/tests/_jest/helpers/env';
import { getWebpackPlugin } from '@dd/tests/_jest/helpers/getWebpackPlugin';
import { defaultEntry, defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS } from '@dd/tests/_jest/helpers/runBundlers';
import { allBundlers } from '@dd/tools/bundlers';
import path from 'path';
import webpack4 from 'webpack4';
import webpack5 from 'webpack5';

import type { MinifiedPathPrefix } from '../types';

import { sendSourcemaps } from './sender';

jest.mock('@dd/error-tracking-plugin/sourcemaps/sender', () => {
    return {
        sendSourcemaps: jest.fn(),
    };
});

const mockSendSourcemaps = jest.mocked(sendSourcemaps);

describe('Error Tracking Sourcemaps', () => {
    // Generate a seed to avoid collision of builds.
    const seed: string = `${Math.abs(jest.getSeed())}.${getUniqueId()}`;
    let workingDir: string;
    const outDirsToRm: string[] = [];

    const getPlugin = (bundler: BundlerFullName, prefix: MinifiedPathPrefix) => {
        const pluginConfig: Options = {
            ...defaultPluginOptions,
            logLevel: 'error',
            errorTracking: {
                sourcemaps: {
                    service: 'test-service',
                    releaseVersion: '1.0.0',
                    minifiedPathPrefix: prefix,
                    bailOnError: false,
                    dryRun: true,
                },
            },
        };

        const allPlugins = {
            webpack5: getWebpackPlugin(pluginConfig, webpack5),
            webpack4: getWebpackPlugin(pluginConfig, webpack4),
            rspack: datadogRspackPlugin(pluginConfig),
            esbuild: datadogEsbuildPlugin(pluginConfig),
            rollup: datadogRollupPlugin(pluginConfig),
            vite: datadogVitePlugin(pluginConfig),
        };

        return allPlugins[bundler];
    };

    const getRxs = (cwd: string, file: string) => {
        const escapeForRx = (st: string) => st.replace(/\\/g, '\\\\');
        return {
            // The output dir can change hence the `[^/]+` part.
            map: `^${escapeForRx(cwd)}/[^/]+/${escapeForRx(file)}.map$`,
            file: `^${escapeForRx(cwd)}/[^/]+/${escapeForRx(file)}$`,
        };
    };

    const useCases: {
        description: string;
        bundler: string;
        config: (cwd: string) => any;
        prefix: string;
        expectedOutputs: string[];
    }[] = [
        {
            description: 'rollup with basic configuration',
            bundler: 'rollup',
            prefix: 'https://example.com/assets',
            expectedOutputs: ['main.js'],
            config: (cwd: string) => ({
                input: {
                    main: path.resolve(cwd, defaultEntry),
                },
                output: {
                    dir: path.resolve(cwd, 'dist-rollup'),
                    sourcemap: true,
                },
            }),
        },
        {
            description: 'rollup with multiple entry points',
            bundler: 'rollup',
            prefix: 'https://example.com/assets',
            expectedOutputs: ['main.js', 'secondary.js'],
            config: (cwd: string) => ({
                input: {
                    main: path.resolve(cwd, defaultEntry),
                    secondary: path.resolve(cwd, defaultEntry),
                },
                output: {
                    dir: path.resolve(cwd, 'dist-rollup-multi'),
                    sourcemap: true,
                },
            }),
        },
        {
            description: 'vite with basic configuration',
            bundler: 'vite',
            prefix: 'https://example.com',
            expectedOutputs: ['assets/main.js'],
            config: (cwd: string) => ({
                root: cwd,
                build: {
                    outDir: 'dist-vite',
                    sourcemap: true,
                    rollupOptions: {
                        input: {
                            main: path.resolve(cwd, defaultEntry),
                        },
                        output: {
                            entryFileNames: 'assets/[name].js',
                        },
                    },
                },
            }),
        },
        {
            description: 'vite with path prefix as path and relative outDir',
            bundler: 'vite',
            prefix: '/static/js',
            expectedOutputs: ['assets/main.js'],
            config: (cwd: string) => ({
                root: cwd,
                build: {
                    outDir: './dist-vite-path',
                    sourcemap: true,
                    rollupOptions: {
                        input: {
                            main: path.resolve(cwd, defaultEntry),
                        },
                        output: {
                            entryFileNames: 'assets/[name].js',
                        },
                    },
                },
            }),
        },
        {
            description: 'webpack 4',
            bundler: 'webpack4',
            prefix: 'https://example.com/assets',
            expectedOutputs: ['main.js'],
            config: (cwd: string) => ({
                context: cwd,
                mode: 'development',
                devtool: 'source-map',
                entry: {
                    main: path.resolve(cwd, defaultEntry),
                },
                output: {
                    path: path.resolve(cwd, 'dist-webpack4'),
                },
            }),
        },
        {
            description: 'webpack 5',
            bundler: 'webpack5',
            prefix: 'https://example.com/assets',
            expectedOutputs: ['main.js'],
            config: (cwd: string) => ({
                context: cwd,
                mode: 'development',
                devtool: 'source-map',
                entry: {
                    main: path.resolve(cwd, defaultEntry),
                },
                output: {
                    path: path.resolve(cwd, 'dist-webpack5'),
                },
            }),
        },
        {
            description: 'rspack with basic configuration',
            bundler: 'rspack',
            prefix: 'https://example.com/assets',
            expectedOutputs: ['main.js'],
            config: (cwd: string) => ({
                context: cwd,
                mode: 'development',
                devtool: 'source-map',
                entry: {
                    main: path.resolve(cwd, defaultEntry),
                },
                output: {
                    path: path.resolve(cwd, 'dist-rspack'),
                },
            }),
        },
        {
            description: 'esbuild with sourcemaps enabled',
            bundler: 'esbuild',
            prefix: 'https://example.com/assets',
            expectedOutputs: ['main.js'],
            config: (cwd: string) => ({
                absWorkingDir: cwd,
                bundle: true,
                entryPoints: {
                    main: path.resolve(cwd, defaultEntry),
                },
                outdir: path.resolve(cwd, 'dist-esbuild'),
                sourcemap: true,
            }),
        },
    ].filter((useCase) => {
        // Filter out bundlers we may have excluded with --bundlers.
        return BUNDLERS.find((b) => b.name === useCase.bundler);
    });

    beforeAll(async () => {
        workingDir = await prepareWorkingDir(seed);
        outDirsToRm.push(workingDir);
    });

    afterAll(async () => {
        if (process.env.NO_CLEANUP) {
            return;
        }
        try {
            await Promise.all(outDirsToRm.map((dir) => rm(dir)));
        } catch (error) {
            // Ignore errors.
        }
    });

    test.each(useCases)(
        'Should handle sourcemaps for $description',
        async ({ bundler, config, prefix, expectedOutputs }) => {
            // Build.
            const runFn = allBundlers[bundler as BundlerFullName].run;
            const { errors } = await runFn({
                ...config(workingDir),
                plugins: [getPlugin(bundler as BundlerFullName, prefix as MinifiedPathPrefix)],
            });

            expect(errors).toEqual([]);
            expect(mockSendSourcemaps).toHaveBeenCalledTimes(1);

            const sourcemaps = mockSendSourcemaps.mock.calls[0][0];

            // Verify sourcemaps were collected
            expect(sourcemaps).toBeDefined();
            expect(sourcemaps).toHaveLength(expectedOutputs.length);

            // Verify each expected sourcemap
            expectedOutputs.forEach((expected) => {
                const sourcemap = sourcemaps.find((src) => src.relativePath === expected)!;
                expect(sourcemap).toBeDefined();

                const rxs = getRxs(workingDir, expected);
                expect(sourcemap).toEqual({
                    minifiedUrl: `${prefix}/${expected}`,
                    relativePath: expected,
                    minifiedFilePath: expect.stringMatching(rxs.file),
                    sourcemapFilePath: expect.stringMatching(rxs.map),
                    minifiedPathPrefix: prefix,
                });
            });
        },
    );
});
