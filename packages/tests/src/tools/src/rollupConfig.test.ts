// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogRspackPlugin } from '@datadog/rspack-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { formatDuration, rm } from '@dd/core/helpers';
import type { BundlerFullName, Options } from '@dd/core/types';
import {
    getEsbuildOptions,
    getRspackOptions,
    getWebpack4Options,
    getWebpack5Options,
} from '@dd/tests/_jest/helpers/configBundlers';
import { BUNDLER_VERSIONS, NO_CLEANUP } from '@dd/tests/_jest/helpers/constants';
import {
    API_PATH,
    FAKE_URL,
    defaultDestination,
    defaultEntries,
    getComplexBuildOverrides,
    getFullPluginConfig,
    getNodeSafeBuildOverrides,
} from '@dd/tests/_jest/helpers/mocks';
import {
    BUNDLERS,
    runEsbuild,
    runRspack,
    runWebpack4,
    runWebpack5,
} from '@dd/tests/_jest/helpers/runBundlers';
import type { CleanupFn } from '@dd/tests/_jest/helpers/types';
import { getWebpack4Entries, getWebpackPlugin } from '@dd/tests/_jest/helpers/xpackConfigs';
import { ROOT } from '@dd/tools/constants';
import { bgYellow, execute, green } from '@dd/tools/helpers';
import type { BuildOptions } from 'esbuild';
import fs from 'fs';
import nock from 'nock';
import path from 'path';

// Mock all the published packages so we can replace them with the built ones.
jest.mock('@datadog/esbuild-plugin', () => ({
    datadogEsbuildPlugin: jest.fn(),
}));
jest.mock('@datadog/rollup-plugin', () => ({
    datadogRollupPlugin: jest.fn(),
}));
jest.mock('@datadog/rspack-plugin', () => ({
    datadogRspackPlugin: jest.fn(),
}));
jest.mock('@datadog/vite-plugin', () => ({
    datadogVitePlugin: jest.fn(),
}));
jest.mock('@datadog/webpack-plugin', () => ({
    datadogWebpackPlugin: jest.fn(),
}));

// Mock the plugin configuration of webpack to actually use the bundled plugin.
jest.mock('@dd/tests/_jest/helpers/xpackConfigs', () => {
    const actual = jest.requireActual('@dd/tests/_jest/helpers/xpackConfigs');
    return {
        ...actual,
        getWebpackPlugin: jest.fn(),
    };
});

const datadogEsbuildPluginMock = jest.mocked(datadogEsbuildPlugin);
const datadogRollupPluginMock = jest.mocked(datadogRollupPlugin);
const datadogRspackPluginMock = jest.mocked(datadogRspackPlugin);
const datadogVitePluginMock = jest.mocked(datadogVitePlugin);
const getWebpackPluginMock = jest.mocked(getWebpackPlugin);

// Ensure our packages have been built not too long ago.
const getPackageDestination = (bundlerName: string) => {
    const packageDestination = path.resolve(
        ROOT,
        `packages/published/${bundlerName}-plugin/dist/src`,
    );

    // If we don't need this bundler, no need to check for its bundle.
    if (BUNDLERS.find((bundler) => bundler.name.startsWith(bundlerName)) === undefined) {
        return packageDestination;
    }

    // Check if the bundle for this bundler is ready and not too old.
    try {
        const stats = fs.statSync(packageDestination);
        const lastUpdateDuration = Math.ceil((new Date().getTime() - stats.mtimeMs) / 1000) * 1000;

        // If last build was more than 10 minutes ago, warn the user.
        if (lastUpdateDuration > 1000 * 60 * 10) {
            console.log(
                bgYellow(
                    ` ${bundlerName}-plugin was last built ${formatDuration(lastUpdateDuration)} ago. \n You should run 'yarn build:all' or 'yarn watch:all'. \n`,
                ),
            );
        }

        // If last build was more than 1 day ago, throw an error.
        if (lastUpdateDuration > 1000 * 60 * 60 * 24) {
            throw new Error(
                `The ${bundlerName}-plugin bundle is too old. Please run 'yarn build:all' first.`,
            );
        }
    } catch (e: any) {
        if (e.code === 'ENOENT') {
            throw new Error(
                `Missing ${bundlerName}-plugin bundle.\nPlease run 'yarn build:all' first.`,
            );
        }
    }

    return packageDestination;
};

describe('Bundling', () => {
    let bundlerVersions: Partial<Record<BundlerFullName, string>> = {};
    let processErrors: string[] = [];
    const seededFolders: string[] = [];
    const pluginConfig = getFullPluginConfig({
        logLevel: 'error',
        customPlugins: (opts, context) => [
            {
                name: 'end-build-plugin',
                writeBundle() {
                    bundlerVersions[context.bundler.fullName] = context.bundler.version;

                    // Add a package.json file to the esm builds.
                    if (['esbuild'].includes(context.bundler.fullName)) {
                        fs.writeFileSync(
                            path.resolve(context.bundler.outDir, 'package.json'),
                            '{ "type": "module" }',
                        );
                    }
                },
            },
        ],
    });

    beforeAll(() => {
        // Duplicate the webpack plugin to have one with webpack 4 and one with webpack 5.
        const webpack5Plugin = getPackageDestination('webpack');
        const webpack4Plugin = path.resolve(webpack5Plugin, 'index4.js');
        // Create a new file that will use webpack4 instead of webpack.
        fs.writeFileSync(
            webpack4Plugin,
            fs
                .readFileSync(path.resolve(webpack5Plugin, 'index.js'), { encoding: 'utf-8' })
                .replace(/require\(('|")webpack("|')\)/g, "require('webpack4')"),
        );

        // Make the mocks target the built packages.
        datadogEsbuildPluginMock.mockImplementation(
            jest.requireActual(getPackageDestination('esbuild')).datadogEsbuildPlugin,
        );
        datadogRollupPluginMock.mockImplementation(
            jest.requireActual(getPackageDestination('rollup')).datadogRollupPlugin,
        );
        datadogRspackPluginMock.mockImplementation(
            jest.requireActual(getPackageDestination('rspack')).datadogRspackPlugin,
        );
        datadogVitePluginMock.mockImplementation(
            jest.requireActual(getPackageDestination('vite')).datadogVitePlugin,
        );

        // Use the correct bundled webpack plugin.
        getWebpackPluginMock.mockImplementation((pluginOptions: Options, bundler: any) => {
            const pluginPath = bundler.version.startsWith('4') ? webpack4Plugin : webpack5Plugin;
            return jest.requireActual(pluginPath).datadogWebpackPlugin(pluginOptions);
        });

        // Mock network requests.
        nock(FAKE_URL)
            .persist()
            // For sourcemaps submissions.
            .post(API_PATH)
            .reply(200, {})
            // For metrics submissions.
            .post('/api/v1/series?api_key=123')
            .reply(200, {});

        // Intercept Node errors. (Especially DeprecationWarnings in the case of Webpack5).
        const actualConsoleError = console.error;
        // Filter out the errors we expect.
        const ignoredErrors = [
            'ExperimentalWarning: VM Modules',
            'ExperimentalWarning: buffer.File',
        ];
        // NOTE: this will trigger only once per session, per error.
        jest.spyOn(console, 'error').mockImplementation((err) => {
            if (!ignoredErrors.some((e) => err.includes(e))) {
                processErrors.push(err);
            }
            actualConsoleError(err);
        });
    });

    afterEach(() => {
        // Reset our records.
        bundlerVersions = {};
        processErrors = [];
    });

    afterAll(async () => {
        nock.cleanAll();
        if (NO_CLEANUP) {
            return;
        }
        console.log('[rollupConfig | Bundling] Cleaning up seeded folders.\n', seededFolders);
        await Promise.all(seededFolders.map((folder) => rm(folder)));
    });

    const nameSize = Math.max(...BUNDLERS.map((bundler) => bundler.name.length)) + 1;
    const TIMESTAMP = Date.now();

    describe.each(BUNDLERS)('Bundler: $name', (bundler) => {
        test('Should not throw on a easy project.', async () => {
            const projectName = 'easy';
            const timeId = `[ ${green(bundler.name.padEnd(nameSize))}] ${green(projectName)} run`;
            console.time(timeId);

            const SEED = `${TIMESTAMP}-${projectName}-${jest.getSeed()}`;
            const rootDir = path.resolve(defaultDestination, SEED);
            const outdir = path.resolve(rootDir, bundler.name);
            seededFolders.push(rootDir);
            const bundlerConfig = bundler.config(
                SEED,
                pluginConfig,
                getNodeSafeBuildOverrides()[bundler.name],
            );

            if (!bundlerConfig) {
                throw new Error(`Missing bundlerConfig for ${bundler.name}.`);
            }

            const bundlerConfigOverrides =
                bundler.name === 'vite' ? bundlerConfig.build.rollupOptions : bundlerConfig;
            const { errors } = await bundler.run(SEED, pluginConfig, bundlerConfigOverrides);
            expect(errors).toHaveLength(0);

            // Test the actual bundled file too.
            await expect(execute('node', [path.resolve(outdir, 'main.js')])).resolves.not.toThrow();

            // It should use the correct version of the bundler.
            // This is to ensure our test is running in the right conditions.
            expect(bundlerVersions[bundler.name]).toBe(BUNDLER_VERSIONS[bundler.name]);

            // It should not have printed any error.
            expect(processErrors).toHaveLength(0);

            console.timeEnd(timeId);

            // Adding some timeout because webpack is SLOW.
        }, 10000);

        test('Should not throw on a hard project.', async () => {
            const projectName = 'hard';
            const timeId = `[ ${green(bundler.name.padEnd(nameSize))}] ${green(projectName)} run`;
            console.time(timeId);

            const SEED = `${TIMESTAMP}-${projectName}-${jest.getSeed()}`;
            const rootDir = path.resolve(defaultDestination, SEED);
            const outdir = path.resolve(rootDir, bundler.name);
            seededFolders.push(rootDir);
            const bundlerConfig = bundler.config(
                SEED,
                pluginConfig,
                getNodeSafeBuildOverrides(getComplexBuildOverrides())[bundler.name],
            );

            if (!bundlerConfig) {
                throw new Error(`Missing bundlerConfig for ${bundler.name}.`);
            }

            // Vite only overrides its options.build.rollupOptions.
            const bundlerConfigOverrides =
                bundler.name === 'vite' ? bundlerConfig.build.rollupOptions : bundlerConfig;

            const { errors } = await bundler.run(SEED, pluginConfig, bundlerConfigOverrides);
            expect(errors).toHaveLength(0);

            // Test the actual bundled file too.
            await expect(execute('node', [path.resolve(outdir, 'app1.js')])).resolves.not.toThrow();
            await expect(execute('node', [path.resolve(outdir, 'app2.js')])).resolves.not.toThrow();

            // It should use the correct version of the bundler.
            // This is to ensure our test is running in the right conditions.
            expect(bundlerVersions[bundler.name]).toBe(BUNDLER_VERSIONS[bundler.name]);

            // It should not have printed any error.
            expect(processErrors).toHaveLength(0);

            console.timeEnd(timeId);

            // Adding some timeout because webpack is SLOW.
        }, 10000);
    });

    test('Should not throw on a weird project.', async () => {
        const projectName = 'weird';
        const timeId = `[ ${green('esbuild + webpack + rspack')}] ${green(projectName)} run`;
        console.time(timeId);

        const SEED = `${TIMESTAMP}-${projectName}-${jest.getSeed()}`;
        const rootDir = path.resolve(defaultDestination, SEED);
        const outdir = path.resolve(rootDir, projectName);
        seededFolders.push(rootDir);
        const configs = getNodeSafeBuildOverrides(getComplexBuildOverrides());

        // Build esbuild somewhere temporary first.
        const esbuildOutdir = path.resolve(outdir, './temp');

        // Configure bundlers.
        const baseEsbuildConfig = getEsbuildOptions(SEED, {}, configs.esbuild);
        const esbuildConfig1: BuildOptions = {
            ...baseEsbuildConfig,
            outdir: esbuildOutdir,
            entryPoints: { app1: defaultEntries.app1 },
            plugins: [
                ...(baseEsbuildConfig.plugins || []),
                // Add a custom loader that will build a new file using the parent configuration.
                {
                    name: 'custom-build-loader',
                    setup(build) {
                        build.onLoad({ filter: /.*\/main1\.js/ }, async ({ path: filepath }) => {
                            const outfile = path.resolve(esbuildOutdir, 'app1.2.js');
                            await runEsbuild(
                                SEED,
                                {},
                                {
                                    ...build.initialOptions,
                                    entryPoints: [filepath],
                                    outfile,
                                    outdir: undefined,
                                    splitting: false,
                                    // Remove all the plugins.
                                    plugins: [],
                                },
                            );

                            return { contents: 'console.log("some logs");', loader: 'js' };
                        });
                    },
                },
            ],
        };

        // Add a second parallel build.
        const esbuildConfig2: BuildOptions = {
            ...baseEsbuildConfig,
            outdir: esbuildOutdir,
            entryPoints: { app2: defaultEntries.app2 },
        };

        // Webpack triggers some deprecations warnings only when we have multi-entry entries.
        const webpackEntries = {
            app1: [
                path.resolve(esbuildOutdir, 'app1.js'),
                '@dd/tests/_jest/fixtures/project/empty.js',
            ],
            app2: [
                path.resolve(esbuildOutdir, 'app2.js'),
                '@dd/tests/_jest/fixtures/project/empty.js',
            ],
        };

        const rspackConfig = {
            ...getRspackOptions(SEED, {}, configs.rspack),
            entry: webpackEntries,
        };

        const webpack5Config = {
            ...getWebpack5Options(SEED, {}, configs.webpack5),
            entry: webpackEntries,
        };

        const webpack4Config = {
            ...getWebpack4Options(SEED, {}, configs.webpack4),
            entry: getWebpack4Entries(webpackEntries),
        };

        // Build the sequence.
        type SequenceReturn = { cleanup: CleanupFn; errors: string[] };
        const sequence: (() => Promise<SequenceReturn | SequenceReturn[]>)[] = [
            () =>
                Promise.all([
                    runEsbuild(SEED, pluginConfig, esbuildConfig1),
                    runEsbuild(SEED, pluginConfig, esbuildConfig2),
                ]),
            () =>
                Promise.all([
                    runWebpack5(SEED, pluginConfig, webpack5Config),
                    runWebpack4(SEED, pluginConfig, webpack4Config),
                    runRspack(SEED, pluginConfig, rspackConfig),
                ]),
        ];

        // Run the sequence.
        for (const run of sequence) {
            // eslint-disable-next-line no-await-in-loop
            const results = await run();

            // Verify there are no errors.
            if (Array.isArray(results)) {
                for (const result of results) {
                    expect(result.errors).toHaveLength(0);
                }
            } else {
                expect(results.errors).toHaveLength(0);
            }
        }

        // It should not have printed any error.
        expect(processErrors).toHaveLength(0);

        console.timeEnd(timeId);
    });
});
