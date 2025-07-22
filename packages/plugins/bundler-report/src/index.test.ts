// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getAbsoluteOutDir, getOutDirsFromOutputs } from '.';
import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogRspackPlugin } from '@datadog/rspack-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { datadogWebpackPlugin } from '@datadog/webpack-plugin';
import { existsSync, rm } from '@dd/core/helpers/fs';
import { getUniqueId } from '@dd/core/helpers/strings';
import type { BundlerName, BundlerReport, Options, Output } from '@dd/core/types';
import { prepareWorkingDir } from '@dd/tests/_jest/helpers/env';
import { defaultEntry, defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS } from '@dd/tests/_jest/helpers/runBundlers';
import { allBundlers } from '@dd/tools/bundlers';
import path from 'path';
import type { OutputOptions } from 'rollup';

describe('Bundler Report', () => {
    describe('getBundlerReportPlugins', () => {
        // Intercept contexts to verify it at the moment they're used.
        const bundlerReports: Record<string, BundlerReport> = {};
        const buildOutputs: Record<string, Output[]> = {};
        const cwds: Record<string, string> = {};

        // Mocks
        const cwdCalls = jest.fn();
        const reportCalls = jest.fn();

        // Generate a seed to avoid collision of builds.
        const seed: string = `${Math.abs(jest.getSeed())}.${getUniqueId()}`;
        let workingDir: string;

        const getPluginConfig = (stores: {
            reports: Record<string, BundlerReport>;
            outputs: Record<string, Output[]>;
            cwds: Record<string, string>;
        }): Options => {
            return {
                ...defaultPluginOptions,
                logLevel: 'error',
                // Use a custom plugin to intercept contexts to verify it at the moment they're used.
                customPlugins: ({ context }) => {
                    const bundlerName = context.bundler.name;
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
                            buildReport(report) {
                                stores.outputs[bundlerName] = report.outputs ?? [];
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

        const pluginConfig = getPluginConfig({
            reports: bundlerReports,
            outputs: buildOutputs,
            cwds,
        });
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
                // Since inputs and outputs are in totally different directories,
                // we fallback to process.cwd().
                expectedCwd: (cwd: string) => process.cwd(),
            },
            {
                description: 'vite with no output',
                bundler: 'vite',
                config: (cwd: string) => ({
                    root: cwd,
                    logLevel: 'error',
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
                    logLevel: 'error',
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
                description:
                    'vite, a relative build.outDir and a relative rollupOptions.output.dir',
                bundler: 'vite',
                config: (cwd: string) => ({
                    root: cwd,
                    logLevel: 'error',
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
                    logLevel: 'error',
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
                    logLevel: 'error',
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
                description: 'webpack with a basic config',
                bundler: 'webpack',
                config: (cwd: string) => ({
                    context: cwd,
                    // Remove warning about unset mode.
                    mode: 'none',
                    entry: {
                        main: path.resolve(cwd, defaultEntry),
                    },
                    output: {
                        // Webpack won't allow relative paths.
                        path: path.resolve(cwd, 'dist-webpack'),
                    },
                    plugins: [datadogWebpackPlugin(pluginConfig)],
                }),
                expectedOutDir: (cwd: string) => path.resolve(cwd, 'dist-webpack'),
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
                // eslint-disable-next-line no-console
                console.log(`[NO_CLEANUP] Working directory: ${workingDir}`);
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
                const buildOptions = config(workingDir);
                // Build.
                const { errors } = await allBundlers[bundler as BundlerName].run(buildOptions);

                expect(errors).toEqual([]);

                const report = bundlerReports[bundler];
                const outputs = buildOutputs[bundler];
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
                const outputFile = path.resolve(outDir, outputs[0].name);
                expect(existsSync(outputFile)).toBeTruthy();

                outDirsToRm.push(outDir);
            },
        );
    });

    describe('getOutDirsFromOutputs', () => {
        const cases = [
            {
                description: 'extract dir from single output object with dir',
                outputOptions: { dir: 'dist' },
                expected: ['dist'],
            },
            {
                description: 'extract dir from single output object with file',
                outputOptions: { file: 'dist/bundle.js' },
                expected: ['dist'],
            },
            {
                description: 'extract dir from array of outputs with dir',
                outputOptions: [{ dir: 'dist' }, { dir: 'dist2' }],
                expected: ['dist', 'dist2'],
            },
            {
                description: 'extract dirs from array of outputs',
                outputOptions: [
                    { file: 'dist/bundle.js' },
                    { file: 'dist2/bundle.js' },
                    { dir: 'dist3' },
                ],
                expected: ['dist', 'dist2', 'dist3'],
            },
            {
                description: 'handle nested file paths',
                outputOptions: { file: 'dist/assets/js/bundle.js' },
                expected: ['dist/assets/js'],
            },
            {
                description: 'return empty array when no dir or file specified',
                outputOptions: [{ format: 'esm' }, { format: 'cjs' }],
                expected: [],
            },
            {
                description: 'return empty array for no outputOptions',
                outputOptions: undefined,
                expected: [],
            },
            {
                description: 'return empty array for empty array',
                outputOptions: [],
                expected: [],
            },
        ];

        test.each(cases)('Should $description', ({ outputOptions, expected }) => {
            expect(getOutDirsFromOutputs(outputOptions as OutputOptions)).toEqual(expected);
        });
    });

    describe('getAbsoluteOutDir', () => {
        const cases = [
            {
                description: 'return empty string when outDir is empty',
                cwd: '/project',
                outDir: '',
                expected: '',
            },
            {
                description: 'return absolute path when outDir is already absolute',
                cwd: '/project',
                outDir: '/absolute/path/dist',
                expected: '/absolute/path/dist',
            },
            {
                description: 'resolve relative path against cwd',
                cwd: '/project',
                outDir: 'dist',
                expected: '/project/dist',
            },
            {
                description: 'resolve relative path with parent directory',
                cwd: '/project/src',
                outDir: '../dist',
                expected: '/project/dist',
            },
            {
                description: 'resolve relative path with current directory',
                cwd: '/project',
                outDir: './dist',
                expected: '/project/dist',
            },
        ];

        test.each(cases)('Should $description', ({ cwd, outDir, expected }) => {
            expect(getAbsoluteOutDir(cwd, outDir)).toBe(expected);
        });
    });
});
