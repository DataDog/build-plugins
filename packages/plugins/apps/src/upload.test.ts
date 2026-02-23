// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getData, getIntakeUrl, getReleaseUrl, uploadArchive } from '@dd/apps-plugin/upload';
import { getDDEnvValue } from '@dd/core/helpers/env';
import { getFile } from '@dd/core/helpers/fs';
import {
    createRequestData,
    doRequest,
    getOriginHeaders,
    NB_RETRIES,
} from '@dd/core/helpers/request';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import stripAnsi from 'strip-ansi';

jest.mock('@dd/core/helpers/env', () => ({
    getDDEnvValue: jest.fn(),
}));

jest.mock('@dd/core/helpers/fs', () => {
    const actual = jest.requireActual('@dd/core/helpers/fs');
    return {
        ...actual,
        getFile: jest.fn(),
    };
});

jest.mock('@dd/core/helpers/request', () => {
    const actual = jest.requireActual('@dd/core/helpers/request');
    return {
        ...actual,
        createRequestData: jest.fn(),
        doRequest: jest.fn(),
        getOriginHeaders: jest.fn(),
    };
});

const getDDEnvValueMock = jest.mocked(getDDEnvValue);
const createRequestDataMock = jest.mocked(createRequestData);
const getFileMock = jest.mocked(getFile);
const doRequestMock = jest.mocked(doRequest);
const getOriginHeadersMock = jest.mocked(getOriginHeaders);

describe('Apps Plugin - upload', () => {
    const archive = {
        archivePath: '/tmp/datadog-apps-assets.zip',
        assets: [{ absolutePath: '/tmp/a.js', relativePath: 'a.js' }],
        size: 1234,
    };
    const context = {
        apiKey: 'api-key',
        appKey: 'app-key',
        bundlerName: 'esbuild',
        dryRun: false,
        identifier: 'repo:app',
        name: 'test-app',
        site: 'datadoghq.com',
        version: '1.0.0',
    };
    const logger = getMockLogger();

    beforeEach(() => {
        getOriginHeadersMock.mockReturnValue({
            'DD-EVP-ORIGIN': 'origin',
            'DD-EVP-ORIGIN-VERSION': '0.0.0',
        });
    });

    describe('getIntakeUrl', () => {
        test('Should use environment override when present', () => {
            getDDEnvValueMock.mockReturnValue('https://custom.apps');
            expect(getIntakeUrl('datadoghq.com', 'my-app')).toBe('https://custom.apps');
        });

        test('Should prefix for all Datadog sites', () => {
            getDDEnvValueMock.mockReturnValue(undefined);
            expect(getIntakeUrl('datadoghq.com', 'my-app')).toBe(
                'https://api.datadoghq.com/api/unstable/app-builder-code/apps/my-app/upload',
            );
            expect(getIntakeUrl('datadoghq.eu', 'my-app')).toBe(
                'https://api.datadoghq.eu/api/unstable/app-builder-code/apps/my-app/upload',
            );
            expect(getIntakeUrl('ddog-gov.com', 'my-app')).toBe(
                'https://api.ddog-gov.com/api/unstable/app-builder-code/apps/my-app/upload',
            );
            expect(getIntakeUrl('us5.datadoghq.com', 'my-app')).toBe(
                'https://api.us5.datadoghq.com/api/unstable/app-builder-code/apps/my-app/upload',
            );
            expect(getIntakeUrl('dd.datad0g.com', 'my-app')).toBe(
                'https://api.dd.datad0g.com/api/unstable/app-builder-code/apps/my-app/upload',
            );
        });
    });

    describe('getReleaseUrl', () => {
        test('Should prefix for all Datadog sites', () => {
            expect(getReleaseUrl('datadoghq.com', 'my-app')).toBe(
                'https://api.datadoghq.com/api/unstable/app-builder-code/apps/my-app/release/live',
            );
            expect(getReleaseUrl('datadoghq.eu', 'my-app')).toBe(
                'https://api.datadoghq.eu/api/unstable/app-builder-code/apps/my-app/release/live',
            );
            expect(getReleaseUrl('ddog-gov.com', 'my-app')).toBe(
                'https://api.ddog-gov.com/api/unstable/app-builder-code/apps/my-app/release/live',
            );
            expect(getReleaseUrl('us5.datadoghq.com', 'my-app')).toBe(
                'https://api.us5.datadoghq.com/api/unstable/app-builder-code/apps/my-app/release/live',
            );
            expect(getReleaseUrl('dd.datad0g.com', 'my-app')).toBe(
                'https://api.dd.datad0g.com/api/unstable/app-builder-code/apps/my-app/release/live',
            );
        });
    });

    describe('getData', () => {
        test('Should build form data with name and bundle', async () => {
            const fakeFile = { name: 'archive' };
            getFileMock.mockResolvedValue(fakeFile as any);
            createRequestDataMock.mockResolvedValue({
                data: 'data' as any,
                headers: { 'x-custom': '1' },
            });

            const getDataFn = getData('/tmp/archive.zip', { 'x-custom': '1' }, 'my-app');
            const data = await getDataFn();

            expect(getFileMock).toHaveBeenCalledWith('/tmp/archive.zip', {
                contentType: 'application/zip',
                filename: 'datadog-apps-assets.zip',
            });
            expect(createRequestDataMock).toHaveBeenCalledWith({
                getForm: expect.any(Function),
                defaultHeaders: { 'x-custom': '1' },
                zip: false,
            });
            expect(data).toEqual({ data: 'data', headers: { 'x-custom': '1' } });
        });

        test('Should append version to form when APPS_VERSION_NAME env var is set', async () => {
            const fakeFile = { name: 'archive' };
            getFileMock.mockResolvedValue(fakeFile as any);
            getDDEnvValueMock.mockImplementation((key) => {
                if (key === 'APPS_VERSION_NAME') {
                    return '1.2.3';
                }
                return undefined;
            });
            let capturedGetForm: (() => FormData | Promise<FormData>) | undefined;
            createRequestDataMock.mockImplementation(async (options) => {
                capturedGetForm = options.getForm;
                return { data: 'data' as any, headers: {} };
            });

            await getData('/tmp/archive.zip', {}, 'my-app')();

            // Mock append to avoid Blob validation errors from the non-Blob archiveFile fixture.
            const appendSpy = jest.spyOn(FormData.prototype, 'append').mockImplementation(() => {});
            await capturedGetForm!();
            expect(appendSpy).toHaveBeenCalledWith('version', '1.2.3');
            appendSpy.mockRestore();
        });

        test('Should not append version to form when APPS_VERSION_NAME env var is only whitespace', async () => {
            const fakeFile = { name: 'archive' };
            getFileMock.mockResolvedValue(fakeFile as any);
            getDDEnvValueMock.mockImplementation((key) => {
                if (key === 'APPS_VERSION_NAME') {
                    return '   ';
                }
                return undefined;
            });
            let capturedGetForm: (() => FormData | Promise<FormData>) | undefined;
            createRequestDataMock.mockImplementation(async (options) => {
                capturedGetForm = options.getForm;
                return { data: 'data' as any, headers: {} };
            });

            await getData('/tmp/archive.zip', {}, 'my-app')();

            const appendSpy = jest.spyOn(FormData.prototype, 'append').mockImplementation(() => {});
            await capturedGetForm!();
            expect(appendSpy).not.toHaveBeenCalledWith('version', expect.anything());
            appendSpy.mockRestore();
        });
    });

    describe('uploadArchive', () => {
        test('Should fail when missing apiKey', async () => {
            const { errors, warnings } = await uploadArchive(
                archive,
                { ...context, apiKey: undefined },
                logger,
            );
            expect(errors).toHaveLength(1);
            expect(errors[0].message).toBe(
                'Missing authentication token, need both app and api keys.',
            );
            expect(warnings).toHaveLength(0);
            expect(doRequestMock).not.toHaveBeenCalled();
        });

        test('Should fail when missing identifier', async () => {
            const { errors, warnings } = await uploadArchive(
                archive,
                { ...context, identifier: '' },
                logger,
            );
            expect(errors).toHaveLength(1);
            expect(errors[0].message).toBe('No app identifier provided');
            expect(warnings).toHaveLength(0);
            expect(doRequestMock).not.toHaveBeenCalled();
        });

        test('Should log configuration and skip request on dryRun', async () => {
            const { errors, warnings } = await uploadArchive(
                archive,
                { ...context, dryRun: true },
                logger,
            );

            expect(errors).toHaveLength(0);
            expect(warnings).toHaveLength(0);
            expect(doRequestMock).not.toHaveBeenCalled();
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('Dry run enabled'),
                'error',
            );
        });

        test('Should upload archive and log summary', async () => {
            doRequestMock.mockResolvedValue({
                version_id: 'v123',
                application_id: 'app123',
                app_builder_id: 'builder123',
            } as any);

            const { errors, warnings } = await uploadArchive(archive, context, logger);

            expect(errors).toHaveLength(0);
            expect(warnings).toHaveLength(0);
            expect(getOriginHeadersMock).toHaveBeenCalledWith({
                bundler: 'esbuild',
                plugin: 'apps',
                version: '1.0.0',
            });
            expect(doRequestMock).toHaveBeenCalledWith({
                auth: { apiKey: 'api-key', appKey: 'app-key' },
                url: 'https://api.datadoghq.com/api/unstable/app-builder-code/apps/repo:app/upload',
                method: 'POST',
                type: 'json',
                getData: expect.any(Function),
                onRetry: expect.any(Function),
            });
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('Your application is available at'),
                'info',
            );
        });

        test('Should make PUT request to release version when APPS_VERSION_NAME is set', async () => {
            getDDEnvValueMock.mockImplementation((key) => {
                if (key === 'APPS_VERSION_NAME') {
                    return 'my-version';
                }
                return undefined;
            });
            doRequestMock
                .mockResolvedValueOnce({
                    version_id: 'v123',
                    application_id: 'app123',
                    app_builder_id: 'builder123',
                })
                .mockResolvedValueOnce({});

            const { errors, warnings } = await uploadArchive(archive, context, logger);

            expect(errors).toHaveLength(0);
            expect(warnings).toHaveLength(0);
            expect(doRequestMock).toHaveBeenCalledTimes(2);
            expect(doRequestMock).toHaveBeenNthCalledWith(2, {
                auth: { apiKey: 'api-key', appKey: 'app-key' },
                url: 'https://api.datadoghq.com/api/unstable/app-builder-code/apps/repo:app/release/live',
                method: 'PUT',
                type: 'json',
                getData: expect.any(Function),
                onRetry: expect.any(Function),
            });
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('Released version'),
                'info',
            );
        });

        test('Should collect warnings on retries', async () => {
            doRequestMock.mockImplementation(async (opts) => {
                opts.onRetry?.(new Error('network'), 2);
            });

            const { warnings } = await uploadArchive(archive, context, logger);

            expect(warnings).toHaveLength(1);
            expect(stripAnsi(warnings[0])).toBe(
                `Failed to upload archive (attempt 2/${NB_RETRIES}): network`,
            );
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('Failed to upload archive'),
                'warn',
            );
        });

        test('Should return errors when upload fails', async () => {
            doRequestMock.mockRejectedValue(new Error('boom'));

            const { errors } = await uploadArchive(archive, context, logger);

            expect(errors).toHaveLength(1);
            expect(errors[0].message).toBe('boom');
        });
    });
});
