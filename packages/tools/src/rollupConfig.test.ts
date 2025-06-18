// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogRspackPlugin } from '@datadog/rspack-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { SUPPORTED_BUNDLERS } from '@dd/core/constants';
import { rm } from '@dd/core/helpers/fs';
import { formatDuration, getUniqueId } from '@dd/core/helpers/strings';
import type { BundlerFullName, Options } from '@dd/core/types';
import {
    getEsbuildOptions,
    getRspackOptions,
    getWebpack4Options,
    getWebpack5Options,
} from '@dd/tests/_jest/helpers/configBundlers';
import { BUNDLER_VERSIONS, KNOWN_ERRORS } from '@dd/tests/_jest/helpers/constants';
import { getOutDir, prepareWorkingDir } from '@dd/tests/_jest/helpers/env';
import { getWebpackPlugin } from '@dd/tests/_jest/helpers/getWebpackPlugin';
import {
    API_PATH,
    FAKE_URL,
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
import { ROOT } from '@dd/tools/constants';
import { bgGreen, bgYellow, execute, green } from '@dd/tools/helpers';
import type { BuildOptions } from 'esbuild';
import fs from 'fs';
import { glob } from 'glob';
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
// And pass the correct bundler to it (webpack4 or webpack5).
jest.mock('@dd/tests/_jest/helpers/getWebpackPlugin', () => {
    const actual = jest.requireActual('@dd/tests/_jest/helpers/getWebpackPlugin');
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

const getPackagePath = (bundlerName: string) => {
    // Cover for names that have a version in it, eg: webpack5, webpack4.
    const cleanBundlerName = SUPPORTED_BUNDLERS.find((name) => bundlerName.startsWith(name));
    if (!cleanBundlerName) {
        throw new Error(`Bundler not supported: "${bundlerName}"`);
    }
    return path.resolve(ROOT, `packages/published/${cleanBundlerName}-plugin/dist/src`);
};

// Ensure our packages have been built not too long ago.
const getPackageDestination = (bundlerName: string) => {
    const packageDestination = getPackagePath(bundlerName);

    // If we don't need this bundler, no need to check for its bundle.
    if (BUNDLERS.find((bundler) => bundler.name.startsWith(bundlerName)) === undefined) {
        return packageDestination;
    }

    // Check if the bundle for this bundler is ready and not too old.
    try {
        const stats = fs.statSync(packageDestination);
        const lastUpdateDuration = Math.ceil((new Date().getTime() - stats.mtimeMs) / 1000) * 1000;

        // If we're in the CI it means we're using cached files.
        if (process.env.CI) {
            console.log(
                bgGreen(
                    ` [CACHED] ${bundlerName}-plugin was built ${formatDuration(lastUpdateDuration)} ago.\n`,
                ),
            );
            // We don't want to block/alert on builds in CI.
            return packageDestination;
        }

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

const getBuiltFiles = () => {
    const pkgs = glob.sync('packages/plugins/**/package.json', { cwd: ROOT });
    const builtFiles = [];

    for (const pkg of pkgs) {
        const content = require(path.resolve(ROOT, pkg));
        if (!content.toBuild) {
            continue;
        }

        builtFiles.push(...Object.keys(content.toBuild).map((f) => `${f}.js`));
    }

    return builtFiles;
};

describe('Bundling', () => {
    let bundlerVersions: Partial<Record<BundlerFullName, string>> = {};
    let processErrors: string[] = [];
    const pluginConfig = getFullPluginConfig({
        logLevel: 'error',
        customPlugins: ({ context }) => [
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
        const actualStderrWrite = process.stderr.write;
        // NOTE: this will trigger only once per session, per error.
        jest.spyOn(process.stderr, 'write').mockImplementation((err, ...args) => {
            const errSt = err.toString();
            // Filter out the errors we expect and know about.
            if (!KNOWN_ERRORS.some((e) => errSt.includes(e))) {
                processErrors.push(errSt.toString());
            }
            return actualStderrWrite(err, ...args);
        });
    });

    afterEach(() => {
        // Reset our records.
        bundlerVersions = {};
        processErrors = [];
    });

    afterAll(async () => {
        nock.cleanAll();
    });

    const nameSize = Math.max(...BUNDLERS.map((bundler) => bundler.name.length)) + 1;

    describe.each(
        // Only do bundlers that are requested to be tested.
        SUPPORTED_BUNDLERS.filter((bundlerName: string) =>
            BUNDLERS.find((bundler) => bundler.name.startsWith(bundlerName)),
        ),
    )('Bundler: %s', (bundlerName) => {
        test(`Should add the correct files to @datadog/${bundlerName}-plugin.`, () => {
            const builtFiles = getBuiltFiles();
            const expectedFiles = [
                'index.d.ts',
                'index.js',
                'index.js.map',
                'index.mjs',
                'index.mjs.map',
                ...builtFiles,
            ].sort();
            const existingFiles = fs.readdirSync(getPackagePath(bundlerName)).sort();
            const exceptions = [
                // We are adding this file ourselves in the test to test both webpack4 and webpack5.
                'index4.js',
            ];
            expect(existingFiles.filter((f) => !exceptions.includes(f))).toEqual(expectedFiles);
        });
    });

    describe.each(BUNDLERS)('Bundler: $name', (bundler) => {
        test.each<{ projectName: string; filesToRun: string[] }>([
            { projectName: 'easy', filesToRun: ['main.js'] },
            { projectName: 'hard', filesToRun: ['app1.js', 'app2.js'] },
        ])(
            'Should not throw on $projectName project.',
            async ({ projectName, filesToRun }) => {
                const timeId = `[ ${green(bundler.name.padEnd(nameSize))}] ${green(projectName)} run`;
                console.time(timeId);

                const SEED = `${jest.getSeed()}.${projectName}.${getUniqueId()}`;
                const rootDir = await prepareWorkingDir(SEED);
                const overrides = getNodeSafeBuildOverrides(
                    rootDir,
                    projectName === 'hard' ? getComplexBuildOverrides() : {},
                );
                const outdir = getOutDir(rootDir, bundler.name);
                const bundlerConfig = bundler.config(
                    rootDir,
                    pluginConfig,
                    overrides[bundler.name],
                );

                if (!bundlerConfig) {
                    throw new Error(`Missing bundlerConfig for ${bundler.name}.`);
                }

                // Our vite run function has a slightly different signature due to how it sets up its bundling.
                const bundlerConfigOverrides =
                    bundler.name === 'vite' ? bundlerConfig.build.rollupOptions : bundlerConfig;

                const { errors } = await bundler.run(rootDir, pluginConfig, bundlerConfigOverrides);
                expect(errors).toHaveLength(0);

                // Test the actual bundled files too.
                await Promise.all(
                    filesToRun
                        .map((f) => path.resolve(outdir, f))
                        .map((file) => expect(execute('node', [file])).resolves.not.toThrow()),
                );

                // It should use the correct version of the bundler.
                // This is to ensure our test is running in the right conditions.
                expect(bundlerVersions[bundler.name]).toBe(BUNDLER_VERSIONS[bundler.name]);

                // It should not have printed any error.
                expect(processErrors).toHaveLength(0);

                // Clean working dir.
                if (!process.env.NO_CLEANUP) {
                    await rm(rootDir);
                }

                console.timeEnd(timeId);

                // Adding some timeout because webpack is SLOW.
            },
            10000,
        );
    });

    test('Should not throw on a weird project.', async () => {
        const projectName = 'weird';
        const timeId = `[ ${green('esbuild + webpack + rspack')}] ${green(projectName)} run`;
        console.time(timeId);

        const SEED = `${jest.getSeed()}.${getUniqueId()}`;
        const rootDir = await prepareWorkingDir(SEED);

        const overrides = getNodeSafeBuildOverrides(rootDir, getComplexBuildOverrides());
        const esbuildOverrides = overrides.esbuild;

        // Configure bundlers.
        const baseEsbuildConfig = getEsbuildOptions(rootDir, {}, esbuildOverrides);
        const esbuildOutdir = baseEsbuildConfig.outdir!;

        const esbuildConfig1: BuildOptions = {
            ...baseEsbuildConfig,
            // Only one entry, we'll build the second one in a parallel build.
            entryPoints: { app1: path.resolve(rootDir, defaultEntries.app1) },
            plugins: [
                ...(baseEsbuildConfig.plugins || []),
                // Add a custom loader that will build a new file using the parent configuration.
                {
                    name: 'custom-build-loader',
                    setup(build) {
                        build.onLoad({ filter: /.*\/main1\.js/ }, async ({ path: filepath }) => {
                            const outfile = path.resolve(build.initialOptions.outdir!, 'app1.2.js');
                            await runEsbuild(
                                rootDir,
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
            ...getEsbuildOptions(rootDir, {}, overrides.esbuild),
            entryPoints: { app2: path.resolve(rootDir, defaultEntries.app2) },
        };

        // Webpack triggers some deprecations warnings only when we have multi-entry entries.
        // Use a function to generate a new object each time.
        const xpackEntries = () => ({
            app1: [path.resolve(esbuildOutdir, 'app1.js'), path.resolve(rootDir, './empty.js')],
            app2: [path.resolve(esbuildOutdir, 'app2.js'), path.resolve(rootDir, './empty.js')],
        });

        const rspackConfig = {
            ...getRspackOptions(rootDir, {}, overrides.rspack),
            entry: xpackEntries(),
        };

        const webpack5Config = {
            ...getWebpack5Options(rootDir, {}, overrides.webpack5),
            entry: xpackEntries(),
        };

        const webpack4Config = {
            ...getWebpack4Options(rootDir, {}, overrides.webpack4),
            entry: xpackEntries(),
        };

        // Build the sequence.
        const sequence: (() => Promise<CleanupFn[]>)[] = [
            () =>
                Promise.all([
                    runEsbuild(rootDir, pluginConfig, esbuildConfig1),
                    runEsbuild(rootDir, pluginConfig, esbuildConfig2),
                ]),
            () =>
                Promise.all([
                    runWebpack5(rootDir, pluginConfig, webpack5Config),
                    runWebpack4(rootDir, pluginConfig, webpack4Config),
                    runRspack(rootDir, pluginConfig, rspackConfig),
                ]),
        ];

        // Run the sequence.
        for (const run of sequence) {
            // eslint-disable-next-line no-await-in-loop
            const results = await run();

            // Verify there are no errors.
            for (const result of results) {
                expect(result.errors).toHaveLength(0);
            }
        }

        // It should not have printed any error.
        expect(processErrors).toHaveLength(0);

        // Clean working dir.
        if (!process.env.NO_CLEANUP) {
            await rm(rootDir);
        }

        console.timeEnd(timeId);
    });
});
