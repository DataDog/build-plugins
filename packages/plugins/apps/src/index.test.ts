// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as archive from '@dd/apps-plugin/archive';
import * as assets from '@dd/apps-plugin/assets';
import * as identifier from '@dd/apps-plugin/identifier';
import * as uploader from '@dd/apps-plugin/upload';
import { getPlugins } from '@dd/apps-plugin';
import * as fsHelpers from '@dd/core/helpers/fs';
import type { PluginOptions } from '@dd/core/types';
import {
    getGetPluginsArg,
    getMockBundler,
    getRepositoryDataMock,
    mockLogFn,
} from '@dd/tests/_jest/helpers/mocks';
import { runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import nock from 'nock';
import path from 'path';

import { APPS_API_PATH } from './constants';

/** Extract and assert closeBundle from the first plugin's vite hooks. */
function extractCloseBundle(plugins: PluginOptions[]) {
    const plugin = plugins[0];
    expect(typeof plugin?.vite?.closeBundle).toBe('function');
    return plugin.vite!.closeBundle as () => Promise<void>;
}

describe('Apps Plugin - getPlugins', () => {
    const buildRoot = '/project';
    const outDir = '/project/dist';
    const getArgs = () =>
        getGetPluginsArg(
            { apps: {} },
            {
                bundler: { ...getMockBundler({ name: 'vite' }), outDir },
                buildRoot,
                git: getRepositoryDataMock({ remote: 'git@github.com:org/repo.git' }),
            },
        );

    beforeEach(() => {
        jest.restoreAllMocks();
    });

    afterAll(() => {
        nock.cleanAll();
    });

    test('Should not initialize when disabled', () => {
        expect(getPlugins(getGetPluginsArg())).toHaveLength(0);
        expect(getPlugins(getGetPluginsArg({ apps: { enable: false } }))).toHaveLength(0);
    });

    test('Should initialize when enabled', () => {
        expect(getPlugins(getArgs())).toHaveLength(1);
    });

    test('Should log an error when identifier cannot be resolved', async () => {
        const collectSpy = jest.spyOn(assets, 'collectAssets').mockResolvedValue([]);
        const uploadSpy = jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({
            errors: [],
            warnings: [],
        });
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({});

        const closeBundle = extractCloseBundle(getPlugins(getArgs()));
        await expect(closeBundle()).rejects.toThrow('Missing apps identification');

        expect(uploadSpy).not.toHaveBeenCalled();
        expect(collectSpy).not.toHaveBeenCalled();
        expect(mockLogFn).toHaveBeenCalledWith(
            expect.stringContaining('Missing apps identification'),
            'error',
        );
    });

    test('Should skip upload when no assets are found', async () => {
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
        jest.spyOn(assets, 'collectAssets').mockResolvedValue([]);
        jest.spyOn(archive, 'createArchive').mockResolvedValue({
            archivePath: '',
            assets: [],
            size: 0,
        });
        jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({
            errors: [],
            warnings: [],
        });
        const rmSpy = jest.spyOn(fsHelpers, 'rm').mockResolvedValue(undefined);

        const closeBundle = extractCloseBundle(
            getPlugins(
                getGetPluginsArg(
                    { apps: { include: ['public/**/*'] } },
                    { bundler: { ...getMockBundler({ name: 'vite' }), outDir }, buildRoot },
                ),
            ),
        );

        await closeBundle();

        expect(assets.collectAssets).toHaveBeenCalledWith(['public/**/*', 'dist/**/*'], buildRoot);
        expect(archive.createArchive).not.toHaveBeenCalled();
        expect(uploader.uploadArchive).not.toHaveBeenCalled();
        expect(rmSpy).not.toHaveBeenCalled();
        expect(mockLogFn).toHaveBeenCalledWith(
            expect.stringContaining('No assets to upload'),
            'debug',
        );
    });

    test('Should upload archive, log warnings and cleanup temp directory', async () => {
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
        const mockedAssets = [
            { absolutePath: '/project/dist/index.js', relativePath: 'dist/index.js' },
        ];
        jest.spyOn(assets, 'collectAssets').mockResolvedValue(mockedAssets);
        jest.spyOn(fsHelpers, 'rm').mockResolvedValue(undefined);
        jest.spyOn(archive, 'createArchive').mockResolvedValue({
            archivePath: '/tmp/dd-apps-123/datadog-apps-assets.zip',
            assets: mockedAssets,
            size: 10,
        });
        jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({
            errors: [],
            warnings: ['first warning'],
        });

        const closeBundle = extractCloseBundle(getPlugins(getArgs()));
        await closeBundle();

        expect(assets.collectAssets).toHaveBeenCalledWith(['dist/**/*'], buildRoot);
        expect(archive.createArchive).toHaveBeenCalledWith([
            {
                absolutePath: '/project/dist/index.js',
                relativePath: path.join('frontend', 'dist/index.js'),
            },
        ]);
        expect(uploader.uploadArchive).toHaveBeenCalledWith(
            expect.objectContaining({ archivePath: '/tmp/dd-apps-123/datadog-apps-assets.zip' }),
            {
                apiKey: '123',
                appKey: '123',
                bundlerName: 'vite',
                dryRun: true,
                identifier: 'repo:app',
                name: 'test-app',
                site: 'example.com',
                version: 'FAKE_VERSION',
            },
            expect.anything(),
        );
        expect(mockLogFn).toHaveBeenCalledWith(
            expect.stringContaining('Warnings while uploading assets'),
            'warn',
        );
        expect(fsHelpers.rm).toHaveBeenCalledWith(path.resolve('/tmp/dd-apps-123'));
    });

    test('Should surface upload errors', async () => {
        jest.spyOn(identifier, 'resolveIdentifier').mockReturnValue({
            identifier: 'repo:app',
            name: 'test-app',
        });
        const mockedAssets = [
            { absolutePath: '/project/dist/app.js', relativePath: 'dist/app.js' },
        ];
        jest.spyOn(assets, 'collectAssets').mockResolvedValue(mockedAssets);
        jest.spyOn(fsHelpers, 'rm').mockResolvedValue(undefined);
        jest.spyOn(archive, 'createArchive').mockResolvedValue({
            archivePath: '/tmp/dd-apps-456/datadog-apps-assets.zip',
            assets: mockedAssets,
            size: 20,
        });
        jest.spyOn(uploader, 'uploadArchive').mockResolvedValue({
            errors: [new Error('upload failed')],
            warnings: [],
        });

        const closeBundle = extractCloseBundle(getPlugins(getArgs()));
        await expect(closeBundle()).rejects.toThrow('upload failed');

        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('upload failed'), 'error');
        expect(fsHelpers.rm).toHaveBeenCalledWith(path.resolve('/tmp/dd-apps-456'));
    });

    test('Should upload assets with vite bundler', async () => {
        const intakeHost = 'https://api.example.com';
        const scope = nock(intakeHost).post(`/${APPS_API_PATH}/app-id/upload`).reply(200, {
            version_id: 'v123',
            application_id: 'app123',
            app_builder_id: 'builder123',
        });

        const { errors } = await runBundlers(
            { apps: { identifier: 'app-id', name: 'test-app', dryRun: false } },
            {},
            ['vite'],
        );

        expect(errors).toHaveLength(0);
        expect(scope.isDone()).toBe(true);
    });
});
