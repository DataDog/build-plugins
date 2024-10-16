// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { datadogWebpackPlugin } from '@datadog/webpack-plugin';
import { formatDuration } from '@dd/core/helpers';
import {
    API_PATH,
    FAKE_URL,
    defaultDestination,
    getComplexBuildOverrides,
    getFullPluginConfig,
    getNodeSafeBuildOverrides,
} from '@dd/tests/helpers/mocks';
import { BUNDLERS } from '@dd/tests/helpers/runBundlers';
import { ROOT } from '@dd/tools/constants';
import { bgYellow, execute } from '@dd/tools/helpers';
import { removeSync } from 'fs-extra';
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
jest.mock('@datadog/vite-plugin', () => ({
    datadogVitePlugin: jest.fn(),
}));
jest.mock('@datadog/webpack-plugin', () => ({
    datadogWebpackPlugin: jest.fn(),
}));

const datadogWebpackPluginMock = jest.mocked(datadogWebpackPlugin);
const datadogEsbuildPluginMock = jest.mocked(datadogEsbuildPlugin);
const datadogRollupPluginMock = jest.mocked(datadogRollupPlugin);
const datadogVitePluginMock = jest.mocked(datadogVitePlugin);

describe('Bundling', () => {
    const pluginConfig = getFullPluginConfig({
        logLevel: 'error',
        customPlugins: (opts, context) => [
            {
                name: 'add-module-package-json',
                writeBundle() {
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
    beforeAll(async () => {
        // Make the mocks target the built packages.
        const getPackageDestination = (bundlerName: string) => {
            const packageDestination = path.resolve(
                ROOT,
                `packages/${bundlerName}-plugin/dist/src`,
            );

            // If we don't need this bundler, no need to check for its bundle.
            if (BUNDLERS.find((bundler) => bundler.name.startsWith(bundlerName)) === undefined) {
                return packageDestination;
            }

            // Check if the bundle for this bundler is ready and not too old.
            try {
                const stats = fs.statSync(packageDestination);
                const lastUpdateDuration =
                    Math.ceil((new Date().getTime() - stats.mtimeMs) / 1000) * 1000;

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

        datadogWebpackPluginMock.mockImplementation(
            jest.requireActual(getPackageDestination('webpack')).datadogWebpackPlugin,
        );
        datadogEsbuildPluginMock.mockImplementation(
            jest.requireActual(getPackageDestination('esbuild')).datadogEsbuildPlugin,
        );
        datadogRollupPluginMock.mockImplementation(
            jest.requireActual(getPackageDestination('rollup')).datadogRollupPlugin,
        );
        datadogVitePluginMock.mockImplementation(
            jest.requireActual(getPackageDestination('vite')).datadogVitePlugin,
        );

        // Mock network requests.
        nock(FAKE_URL)
            .persist()
            // For sourcemaps submissions.
            .post(API_PATH)
            .reply(200, {})
            // For metrics submissions.
            .post('/api/v1/series?api_key=123')
            .reply(200, {});
    });

    afterAll(async () => {
        nock.cleanAll();
        removeSync(path.resolve(ROOT, 'packages/tests/src/fixtures/dist'));
    });

    describe.each(BUNDLERS)('Bundler: $name', (bundler) => {
        test('Should not throw on a simple project.', async () => {
            const SEED = `${Date.now()}-basic-${jest.getSeed()}`;
            const outdir = path.resolve(defaultDestination, SEED, bundler.name);
            const bundlerConfig =
                getNodeSafeBuildOverrides()[bundler.name as keyof typeof getNodeSafeBuildOverrides];

            if (!bundlerConfig) {
                throw new Error(`Missing bundlerConfig for ${bundler.name}.`);
            }

            const { errors } = await bundler.run(SEED, pluginConfig, bundlerConfig);
            expect(errors).toHaveLength(0);

            // Test the actual bundled file too.
            await expect(execute('node', [path.resolve(outdir, 'main.js')])).resolves.not.toThrow();
        });

        test('Should not throw on a complex project.', async () => {
            const bundlerConfig = getNodeSafeBuildOverrides(getComplexBuildOverrides())[
                bundler.name as keyof typeof getNodeSafeBuildOverrides
            ];
            const SEED = `${Date.now()}-complex-${jest.getSeed()}`;
            const outdir = path.resolve(defaultDestination, SEED, bundler.name);
            const { errors } = await bundler.run(SEED, pluginConfig, bundlerConfig);
            expect(errors).toHaveLength(0);

            // Test the actual bundled file too.
            await expect(execute('node', [path.resolve(outdir, 'app1.js')])).resolves.not.toThrow();
            await expect(execute('node', [path.resolve(outdir, 'app2.js')])).resolves.not.toThrow();
        });
    });
});
