// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogRspackPlugin } from '@datadog/rspack-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { existsSync, rm } from '@dd/core/helpers/fs';
import { getUniqueId } from '@dd/core/helpers/strings';
import type { BundlerFullName, BundlerReport, Options } from '@dd/core/types';
import { prepareWorkingDir } from '@dd/tests/_jest/helpers/env';
import { getWebpackPlugin } from '@dd/tests/_jest/helpers/getWebpackPlugin';
import { defaultEntry, defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS } from '@dd/tests/_jest/helpers/runBundlers';
import { allBundlers } from '@dd/tools/bundlers';
import path from 'path';
import webpack4 from 'webpack4';
import webpack5 from 'webpack5';

describe('Bundler Report', () => {
    // Intercept contexts to verify it at the moment they're used.
    const bundlerReports: Record<string, BundlerReport> = {};
    const cwds: Record<string, string> = {};

    // Mocks
    const cwdCalls = jest.fn();
    const reportCalls = jest.fn();

    // Generate a seed to avoid collision of builds.
    const seed: string = `${Math.abs(jest.getSeed())}.${getUniqueId()}`;
    let workingDir: string;

    const getPluginConfig = (stores: {
        reports: Record<string, BundlerReport>;
        cwds: Record<string, string>;
    }): Options => {
        return {
            ...defaultPluginOptions,
            logLevel: 'error',
            // Use a custom plugin to intercept contexts to verify it at the moment they're used.
            customPlugins: ({ context }) => {
                const bundlerName = context.bundler.fullName;
                return [
                    {
                        name: 'custom-plugin',
                        bundlerReport(report) {
                            reportCalls();
                            const config = report.rawConfig;
                            stores.reports[bundlerName] = JSON.parse(
                                JSON.stringify({
                                    ...report,
                                    // This is not safe to stringify.
                                    rawConfig: null,
                                }),
                            );
                            stores.reports[bundlerName].rawConfig = config;
                        },
                        cwd(cwd) {
                            cwdCalls();
                            stores.cwds[bundlerName] = cwd;
                        },
                    },
                ];
            },
        };
    };

    const pluginConfig = getPluginConfig({ reports: bundlerReports, cwds });
    const outDirsToRm: string[] = [];
    const useCases: {
        description: string;
        bundler: string;
        config: any;
        expectedOutDir: (cwd: string) => string;
        expectedCwd: (cwd: string) => string;
    }[] = [
        {
            description: 'rollup and an absolute output directory',
            bundler: 'rollup',
            config: (cwd: string) => ({
                input: {
                    main: path.resolve(cwd, defaultEntry),
                },
                output: {
                    dir: path.resolve(cwd, 'dist-rollup'),
                },
                plugins: [datadogRollupPlugin(pluginConfig)],
            }),
            expectedOutDir: (cwd: string) => path.resolve(cwd, 'dist-rollup'),
            expectedCwd: (cwd: string) => cwd,
        },
        {
            description: 'rollup and a relative output directory',
            bundler: 'rollup',
            config: (cwd: string) => ({
                input: {
                    main: path.resolve(cwd, defaultEntry),
                },
                output: {
                    dir: 'dist-rollup-1',
                },
                plugins: [datadogRollupPlugin(pluginConfig)],
            }),
            // Rollup will use process.cwd() as the base for relative paths.
            expectedOutDir: () => path.resolve(process.cwd(), 'dist-rollup-1'),
            // Rollup can only compute the CWD from the input files.
            expectedCwd: (cwd: string) => path.resolve(cwd, path.dirname(defaultEntry)),
        },
        {
            description: 'vite with no output',
            bundler: 'vite',
            config: (cwd: string) => ({
                root: cwd,
                build: {
                    rollupOptions: {
                        input: {
                            main: path.resolve(cwd, defaultEntry),
                        },
                    },
                },
                plugins: [datadogVitePlugin(pluginConfig)],
            }),
            // Rollup will fallback to its default root/dist.
            expectedOutDir: (cwd: string) => path.resolve(cwd, 'dist'),
            expectedCwd: (cwd: string) => cwd,
        },
        {
            description: 'vite and a relative build.outDir',
            bundler: 'vite',
            config: (cwd: string) => ({
                root: cwd,
                build: {
                    outDir: './dist-vite',
                    rollupOptions: {
                        input: {
                            main: path.resolve(cwd, defaultEntry),
                        },
                    },
                },
                plugins: [datadogVitePlugin(pluginConfig)],
            }),
            expectedOutDir: (cwd: string) => path.resolve(cwd, 'dist-vite'),
            expectedCwd: (cwd: string) => cwd,
        },
        {
            description: 'vite, a relative build.outDir and a relative rollupOptions.output.dir',
            bundler: 'vite',
            config: (cwd: string) => ({
                root: cwd,
                build: {
                    outDir: 'dist-vite-2',
                    rollupOptions: {
                        input: {
                            main: path.resolve(cwd, defaultEntry),
                        },
                        output: {
                            // This will take precedence and fallback to rollup's behavior.
                            dir: 'dist-vite-3',
                        },
                    },
                },
                plugins: [datadogVitePlugin(pluginConfig)],
            }),
            expectedOutDir: (cwd: string) => path.resolve(process.cwd(), 'dist-vite-3'),
            expectedCwd: (cwd: string) => cwd,
        },
        {
            description: 'vite and an absolute build.outDir',
            bundler: 'vite',
            config: (cwd: string) => ({
                root: cwd,
                build: {
                    outDir: path.resolve(cwd, '../dist-vite-4'),
                    // Remove the warning about outDir being outside of root.
                    emptyOutDir: false,
                    rollupOptions: {
                        input: {
                            main: path.resolve(cwd, defaultEntry),
                        },
                    },
                },
                plugins: [datadogVitePlugin(pluginConfig)],
            }),
            expectedOutDir: (cwd: string) => path.resolve(cwd, '../dist-vite-4'),
            expectedCwd: (cwd: string) => cwd,
        },
        {
            description: 'vite and no root',
            bundler: 'vite',
            config: (cwd: string) => ({
                build: {
                    outDir: './dist-vite-5',
                    rollupOptions: {
                        input: {
                            main: path.resolve(cwd, defaultEntry),
                        },
                    },
                },
                plugins: [datadogVitePlugin(pluginConfig)],
            }),
            expectedOutDir: () => path.resolve(process.cwd(), 'dist-vite-5'),
            expectedCwd: () => process.cwd(),
        },
        {
            description: 'webpack 4 with a basic config',
            bundler: 'webpack4',
            config: (cwd: string) => ({
                context: cwd,
                // Remove warning about unset mode.
                mode: 'none',
                entry: {
                    main: path.resolve(cwd, defaultEntry),
                },
                output: {
                    // Webpack won't allow relative paths.
                    path: path.resolve(cwd, 'dist-webpack4'),
                },
                // Need to use an helper to differentiate webpack5 from webpack4.
                plugins: [getWebpackPlugin(pluginConfig, webpack4)],
            }),
            expectedOutDir: (cwd: string) => path.resolve(cwd, 'dist-webpack4'),
            expectedCwd: (cwd: string) => cwd,
        },
        {
            description: 'webpack 5 with a basic config',
            bundler: 'webpack5',
            config: (cwd: string) => ({
                context: cwd,
                // Remove warning about unset mode.
                mode: 'none',
                entry: {
                    main: path.resolve(cwd, defaultEntry),
                },
                output: {
                    // Webpack won't allow relative paths.
                    path: path.resolve(cwd, 'dist-webpack5'),
                },
                // Need to use an helper to differentiate webpack5 from webpack4.
                plugins: [getWebpackPlugin(pluginConfig, webpack5)],
            }),
            expectedOutDir: (cwd: string) => path.resolve(cwd, 'dist-webpack5'),
            expectedCwd: (cwd: string) => cwd,
        },
        {
            description: 'rspack with a relative output.path',
            bundler: 'rspack',
            config: (cwd: string) => ({
                context: cwd,
                entry: {
                    main: path.resolve(cwd, defaultEntry),
                },
                output: {
                    path: 'dist-rspack',
                },
                plugins: [datadogRspackPlugin(pluginConfig)],
            }),
            expectedOutDir: () => path.resolve(process.cwd(), 'dist-rspack'),
            expectedCwd: (cwd: string) => cwd,
        },
        {
            description: 'rspack with an absolute output.path',
            bundler: 'rspack',
            config: (cwd: string) => ({
                context: cwd,
                entry: {
                    main: path.resolve(cwd, defaultEntry),
                },
                output: {
                    path: path.resolve(cwd, 'dist-rspack'),
                },
                plugins: [datadogRspackPlugin(pluginConfig)],
            }),
            expectedOutDir: (cwd: string) => path.resolve(cwd, 'dist-rspack'),
            expectedCwd: (cwd: string) => cwd,
        },
        {
            description: 'esbuild with a relative outdir',
            bundler: 'esbuild',
            config: (cwd: string) => ({
                absWorkingDir: cwd,
                bundle: true,
                entryPoints: {
                    main: path.resolve(cwd, defaultEntry),
                },
                outdir: 'dist-esbuild',
                plugins: [datadogEsbuildPlugin(pluginConfig)],
            }),
            expectedOutDir: (cwd: string) => path.resolve(cwd, 'dist-esbuild'),
            expectedCwd: (cwd: string) => cwd,
        },
        {
            description: 'esbuild with an absolute outdir',
            bundler: 'esbuild',
            config: (cwd: string) => ({
                absWorkingDir: cwd,
                bundle: true,
                entryPoints: {
                    main: path.resolve(cwd, defaultEntry),
                },
                outdir: path.resolve(cwd, 'dist-esbuild-2'),
                plugins: [datadogEsbuildPlugin(pluginConfig)],
            }),
            expectedOutDir: (cwd: string) => path.resolve(cwd, 'dist-esbuild-2'),
            expectedCwd: (cwd: string) => cwd,
        },
        {
            description: 'esbuild with a relative outfile',
            bundler: 'esbuild',
            config: (cwd: string) => ({
                absWorkingDir: cwd,
                bundle: true,
                entryPoints: {
                    main: path.resolve(cwd, defaultEntry),
                },
                outfile: 'dist-esbuild-2/main.js',
                plugins: [datadogEsbuildPlugin(pluginConfig)],
            }),
            expectedOutDir: (cwd: string) => path.resolve(cwd, 'dist-esbuild-2'),
            expectedCwd: (cwd: string) => cwd,
        },
        {
            description: 'esbuild with an absolute outfile',
            bundler: 'esbuild',
            config: (cwd: string) => ({
                absWorkingDir: cwd,
                bundle: true,
                entryPoints: {
                    main: path.resolve(cwd, defaultEntry),
                },
                outfile: path.resolve(cwd, 'dist-esbuild-3/main.js'),
                plugins: [datadogEsbuildPlugin(pluginConfig)],
            }),
            expectedOutDir: (cwd: string) => path.resolve(cwd, 'dist-esbuild-3'),
            expectedCwd: (cwd: string) => cwd,
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
        'Should report for $description',
        async ({ bundler, config, expectedOutDir, expectedCwd }) => {
            // Build.
            const { errors } = await allBundlers[bundler as BundlerFullName].run(
                config(workingDir),
            );

            expect(errors).toEqual([]);

            const report = bundlerReports[bundler];
            const outDir = expectedOutDir(workingDir);

            expect(report.outDir).toBe(outDir);

            expect(report.rawConfig).toBeDefined();
            expect(report.rawConfig).toEqual(expect.any(Object));
            expect(cwds[bundler]).toBe(expectedCwd(workingDir));

            // It should have called the custom hooks only once.
            expect(reportCalls).toHaveBeenCalledTimes(1);
            expect(cwdCalls).toHaveBeenCalledTimes(1);

            // Confirm that we follow the bundler's behavior.
            expect(existsSync(outDir)).toBeTruthy();

            outDirsToRm.push(outDir);
        },
    );
});
