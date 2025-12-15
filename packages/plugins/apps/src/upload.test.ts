// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getData, getIntakeUrl, uploadArchive } from '@dd/apps-plugin/upload';
import { getDDEnvValue } from '@dd/core/helpers/env';
import { getFile } from '@dd/core/helpers/fs';
import {
    createGzipFormData,
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
        createGzipFormData: jest.fn(),
        doRequest: jest.fn(),
        getOriginHeaders: jest.fn(),
    };
});

const getDDEnvValueMock = jest.mocked(getDDEnvValue);
const createGzipFormDataMock = jest.mocked(createGzipFormData);
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
        bundlerName: 'esbuild',
        dryRun: false,
        identifier: 'repo:app',
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
            expect(getIntakeUrl('datadoghq.com')).toBe('https://custom.apps');
        });

        test('Should fallback to default intake url', () => {
            getDDEnvValueMock.mockReturnValue(undefined);
            expect(getIntakeUrl('datadoghq.eu')).toBe(
                'https://apps-intake.datadoghq.eu/api/v1/apps',
            );
        });
    });

    describe('getData', () => {
        test('Should build form data with identifier and archive', async () => {
            const appendMock = jest.fn();
            const fakeFile = { name: 'archive' };
            getFileMock.mockResolvedValue(fakeFile as any);
            createGzipFormDataMock.mockImplementation(async (builder, defaultHeaders = {}) => {
                await builder({ append: appendMock } as any);
                return { data: 'data', headers: defaultHeaders } as any;
            });

            const getDataFn = getData('/tmp/archive.zip', { 'x-custom': '1' }, 'my-app');
            const data = await getDataFn();

            expect(getFileMock).toHaveBeenCalledWith('/tmp/archive.zip', {
                contentType: 'application/zip',
                filename: 'datadog-apps-assets.zip',
            });
            expect(appendMock).toHaveBeenCalledWith('identifier', 'my-app');
            expect(appendMock).toHaveBeenCalledWith('archive', fakeFile, 'datadog-apps-assets.zip');
            expect(data).toEqual({ data: 'data', headers: { 'x-custom': '1' } });
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
            expect(errors[0].message).toBe('No authentication token provided');
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
            doRequestMock.mockResolvedValue(undefined as any);

            const { errors, warnings } = await uploadArchive(archive, context, logger);

            expect(errors).toHaveLength(0);
            expect(warnings).toHaveLength(0);
            expect(getOriginHeadersMock).toHaveBeenCalledWith({
                bundler: 'esbuild',
                plugin: 'apps',
                version: '1.0.0',
            });
            expect(doRequestMock).toHaveBeenCalledWith({
                auth: { apiKey: 'api-key' },
                url: 'https://apps-intake.datadoghq.com/api/v1/apps',
                method: 'POST',
                getData: expect.any(Function),
                onRetry: expect.any(Function),
            });
            expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('Uploaded'), 'info');
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
