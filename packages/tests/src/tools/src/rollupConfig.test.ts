import { datadogEsbuildPlugin } from '@datadog/esbuild-plugin';
import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { datadogWebpackPlugin } from '@datadog/webpack-plugin';
import {
    API_PATH,
    FAKE_URL,
    getComplexBuildOverrides,
    getFullPluginConfig,
} from '@dd/tests/helpers/mocks';
import { BUNDLERS } from '@dd/tests/helpers/runBundlers';
import { ROOT } from '@dd/tools/constants';
import { execute } from '@dd/tools/helpers';
import { removeSync } from 'fs-extra';
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
    const complexProjectOverrides = getComplexBuildOverrides();
    const pluginConfig = getFullPluginConfig();
    beforeAll(async () => {
        // First, bundle the plugins.
        // FIXME: This is slow because of the dts() build.
        await execute('yarn', ['build:all']);

        // Make the mocks target the built packages.
        const getPackageDestination = (bundlerName: string) => {
            return path.resolve(ROOT, `packages/${bundlerName}-plugin/dist/src`);
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
    }, 30000);

    afterAll(async () => {
        nock.cleanAll();
        removeSync(path.resolve(ROOT, 'packages/tests/src/fixtures/dist'));
    });

    describe.each(BUNDLERS)('Bundler: $name', (bundler) => {
        test('Should not throw on a simple project.', async () => {
            const SEED = `${Date.now()}-${jest.getSeed()}`;
            const { errors } = await bundler.run(SEED, pluginConfig, {});
            expect(errors).toHaveLength(0);
        });

        test('Should not throw on a complex project.', async () => {
            const SEED = `${Date.now()}-${jest.getSeed()}`;
            const { errors } = await bundler.run(
                SEED,
                pluginConfig,
                complexProjectOverrides[bundler.name],
            );
            expect(errors).toHaveLength(0);
        });
    });
});
