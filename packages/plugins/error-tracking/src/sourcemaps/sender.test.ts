// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFileSync, rmSync } from '@dd/core/helpers/fs';
import { doRequest } from '@dd/core/helpers/request';
import {
    getData,
    getIntakeUrl,
    sendSourcemaps,
    upload,
    SOURCEMAPS_API_SUBDOMAIN,
    SOURCEMAPS_API_PATH,
} from '@dd/error-tracking-plugin/sourcemaps/sender';
import { SOURCEMAP_UPLOAD_METRIC_PREFIX } from '@dd/error-tracking-plugin/sourcemaps/upload-metrics';
import {
    getContextMock,
    mockLogFn,
    mockLogger,
    getPayloadMock,
    getDebugIdSourcemapsConfiguration,
    getSourcemapMock,
    getSourcemapsConfiguration,
    addFixtureFiles,
} from '@dd/tests/_jest/helpers/mocks';
import os from 'os';
import path from 'path';

import * as payloadModule from './payload';

jest.mock('@dd/core/helpers/fs', () => {
    const original = jest.requireActual('@dd/core/helpers/fs');
    return {
        ...original,
        checkFile: jest.fn(),
        getFile: jest.fn(),
    };
});

jest.mock('@dd/core/helpers/request', () => {
    const original = jest.requireActual('@dd/core/helpers/request');
    return {
        ...original,
        doRequest: jest.fn(),
    };
});

const doRequestMock = jest.mocked(doRequest);

const contextMock = getContextMock();
const uploadContextMock = {
    addMetric: contextMock.addMetric,
    apiKey: contextMock.auth.apiKey,
    bundlerName: contextMock.bundler.name,
    site: contextMock.auth.site,
    version: contextMock.version,
    outDir: contextMock.bundler.outDir,
};
const senderContextMock = {
    ...uploadContextMock,
    git: contextMock.git,
};

describe('Error Tracking Plugin Sourcemaps', () => {
    describe('getIntakeUrl', () => {
        const originalEnv = process.env;

        beforeEach(() => {
            process.env = { ...originalEnv };
        });

        afterEach(() => {
            process.env = originalEnv;
        });

        test('Should return correct intake URL for US3 site', () => {
            expect(getIntakeUrl('us3.datadoghq.com')).toBe(
                `https://${SOURCEMAPS_API_SUBDOMAIN}.us3.datadoghq.com/${SOURCEMAPS_API_PATH}`,
            );
        });

        test('Should use DATADOG_SOURCEMAP_INTAKE_URL env var when set', () => {
            const customUrl = 'https://custom.intake.url/api/v2/srcmap';
            process.env.DATADOG_SOURCEMAP_INTAKE_URL = customUrl;

            expect(getIntakeUrl('datadoghq.com')).toBe(customUrl);
            expect(getIntakeUrl('datadoghq.eu')).toBe(customUrl);
        });
    });

    describe('getData', () => {
        test('Should return the correct data and headers', async () => {
            // Add some fixtures.
            addFixtureFiles({
                '/path/to/minified.min.js': 'Some JS File with some content.',
                '/path/to/sourcemap.js.map': '{"version":3,"sources":["/path/to/minified.min.js"]}',
            });

            const payload = getPayloadMock();

            const { data, headers } = await getData(payload)();
            const unzippedData = await new Response(
                data.pipeThrough(new DecompressionStream('gzip')),
            ).text();
            const dataLines = unzippedData.split(/[\r\n]/g).filter(Boolean);
            const boundary = headers['content-type']
                .split('boundary=')
                .pop()!
                .replace(/^(-)+/g, '');

            expect(boundary).toBeTruthy();
            expect(dataLines[0]).toMatch(boundary);
            expect(dataLines[dataLines.length - 1]).toMatch(boundary);
        });
    });

    describe('sendSourcemaps', () => {
        test('Should upload sourcemaps.', async () => {
            // Add some fixtures.
            addFixtureFiles({
                '/path/to/minified.min.js': 'Some JS File with some content.',
                '/path/to/sourcemap.js.map': '{"version":3,"sources":["/path/to/minified.min.js"]}',
            });

            await sendSourcemaps(
                [getSourcemapMock()],
                getSourcemapsConfiguration(),
                senderContextMock,
                mockLogger,
            );

            expect(doRequestMock).toHaveBeenCalledTimes(1);
        });

        test('Should alert in case of payload issues', async () => {
            // Add some fixtures.
            addFixtureFiles({
                '/path/to/minified.min.js': '',
            });

            await sendSourcemaps(
                [getSourcemapMock()],
                getSourcemapsConfiguration(),
                senderContextMock,
                mockLogger,
            );

            // Only the debug ID extraction summary (debug) and the payload error (error)
            // should be logged — the debug summary logs unconditionally before the error check.
            expect(mockLogFn.mock.calls.filter(([, level]) => level === 'error')).toHaveLength(1);
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringMatching('Failed to prepare payloads, aborting upload'),
                'error',
            );
            expect(doRequestMock).not.toHaveBeenCalled();
        });

        test('Should throw in case of payload issues and bailOnError', async () => {
            // Add some fixtures.
            addFixtureFiles({
                '/path/to/minified.min.js': '',
            });

            await expect(async () => {
                await sendSourcemaps(
                    [getSourcemapMock()],
                    getSourcemapsConfiguration({ bailOnError: true }),
                    senderContextMock,
                    mockLogger,
                );
            }).rejects.toThrow('Failed to prepare payloads, aborting upload');
            expect(doRequestMock).not.toHaveBeenCalled();
        });

        test('Should resolve the debug ID straight from the minified file content, regardless of its filename', async () => {
            // The minified file's name here has nothing to do with the debug ID lookup —
            // it's extracted from the file's own content, so it survives any bundler
            // renaming step (e.g. webpack/rspack's realContentHash) that happens after
            // the RUM plugin injects it.
            const debugId = '12345678-1234-4123-8123-123456789012';
            // Minifiers strip quotes from object keys that are valid identifiers, so the
            // real on-disk shape has an unquoted key, not `"ddDebugId":"..."`.
            const minifiedFileContent = `Some JS File with some content.(function(c,n){...})({ddDebugId:"${debugId}"},"DD_SOURCE_CODE_CONTEXT");`;
            // debugId.ts reads the minified file straight off disk (not through a mockable
            // fs helper), so it needs a real file on top of the virtual fixture used for
            // the checkFile validity checks below.
            const tempDir = path.join(os.tmpdir(), 'dd-build-plugins-sender-debug-id-test');
            const minifiedFilePath = path.join(tempDir, 'minified.min.js');
            outputFileSync(minifiedFilePath, minifiedFileContent);

            addFixtureFiles({
                [minifiedFilePath]: minifiedFileContent,
                '/path/to/sourcemap.js.map': '{"version":3,"sources":["/path/to/minified.min.js"]}',
            });

            const getPayloadSpy = jest.spyOn(payloadModule, 'getPayload');

            const sourcemap = getSourcemapMock({
                minifiedFilePath,
                relativePath: 'path/to/minified.min.js',
            });

            await sendSourcemaps(
                [sourcemap],
                getSourcemapsConfiguration(),
                senderContextMock,
                mockLogger,
            );

            expect(getPayloadSpy).toHaveBeenCalledTimes(1);
            const debugIdArg = getPayloadSpy.mock.calls[0][4];
            expect(debugIdArg).toBe(debugId);

            getPayloadSpy.mockRestore();
            rmSync(tempDir);
        });

        test('Should upload by debug ID without service, version, or path configuration', async () => {
            const debugId = '12345678-1234-4123-8123-123456789012';
            const minifiedFileContent = `({ddDebugId:"${debugId}"},"DD_SOURCE_CODE_CONTEXT");`;
            const tempDir = path.join(os.tmpdir(), 'dd-build-plugins-debug-id-upload-test');
            const minifiedFilePath = path.join(tempDir, 'app.js');
            const sourcemapFilePath = path.join(tempDir, 'app.js.map');
            outputFileSync(minifiedFilePath, minifiedFileContent);
            outputFileSync(sourcemapFilePath, '{"version":3,"sources":["app.js"]}');
            addFixtureFiles({
                [minifiedFilePath]: minifiedFileContent,
                [sourcemapFilePath]: '{"version":3,"sources":["app.js"]}',
            });
            const getPayloadSpy = jest.spyOn(payloadModule, 'getPayload');

            await sendSourcemaps(
                [
                    getSourcemapMock({
                        minifiedFilePath,
                        minifiedPathPrefix: undefined,
                        minifiedUrl: 'app.js',
                        relativePath: 'app.js',
                        sourcemapFilePath,
                    }),
                ],
                getDebugIdSourcemapsConfiguration(),
                senderContextMock,
                mockLogger,
            );

            expect(getPayloadSpy).toHaveBeenCalledTimes(1);
            expect(getPayloadSpy.mock.calls[0][1]).not.toHaveProperty('service');
            expect(getPayloadSpy.mock.calls[0][1]).not.toHaveProperty('version');
            expect(getPayloadSpy.mock.calls[0][4]).toBe(debugId);

            getPayloadSpy.mockRestore();
            rmSync(tempDir);
        });

        test('Should skip files without a debug ID and upload the remaining sourcemaps', async () => {
            const debugId = '12345678-1234-4123-8123-123456789012';
            const tempDir = path.join(os.tmpdir(), 'dd-build-plugins-partial-debug-id-test');
            const minifiedFileWithDebugId = path.join(tempDir, 'with-debug-id.js');
            const minifiedFileWithoutDebugId = path.join(tempDir, 'without-debug-id.js');
            const sourcemapWithDebugId = path.join(tempDir, 'with-debug-id.js.map');
            const sourcemapWithoutDebugId = path.join(tempDir, 'without-debug-id.js.map');
            const contentWithDebugId = `({ddDebugId:"${debugId}"},"DD_SOURCE_CODE_CONTEXT");`;
            const contentWithoutDebugId = 'console.log("no debug id");';
            const sourcemapContent = '{"version":3,"sources":[]}';

            outputFileSync(minifiedFileWithDebugId, contentWithDebugId);
            outputFileSync(minifiedFileWithoutDebugId, contentWithoutDebugId);
            outputFileSync(sourcemapWithDebugId, sourcemapContent);
            outputFileSync(sourcemapWithoutDebugId, sourcemapContent);
            addFixtureFiles({
                [minifiedFileWithDebugId]: contentWithDebugId,
                [minifiedFileWithoutDebugId]: contentWithoutDebugId,
                [sourcemapWithDebugId]: sourcemapContent,
                [sourcemapWithoutDebugId]: sourcemapContent,
            });
            const getPayloadSpy = jest.spyOn(payloadModule, 'getPayload');

            await sendSourcemaps(
                [
                    getSourcemapMock({
                        minifiedFilePath: minifiedFileWithDebugId,
                        sourcemapFilePath: sourcemapWithDebugId,
                    }),
                    getSourcemapMock({
                        minifiedFilePath: minifiedFileWithoutDebugId,
                        sourcemapFilePath: sourcemapWithoutDebugId,
                    }),
                ],
                getDebugIdSourcemapsConfiguration(),
                senderContextMock,
                mockLogger,
            );

            expect(getPayloadSpy).toHaveBeenCalledTimes(1);
            expect(getPayloadSpy).toHaveBeenCalledWith(
                expect.objectContaining({ minifiedFilePath: minifiedFileWithDebugId }),
                expect.any(Object),
                undefined,
                senderContextMock.git,
                debugId,
            );
            expect(doRequestMock).toHaveBeenCalledTimes(1);
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining(
                    `Skipping sourcemap ${sourcemapWithoutDebugId} because no debug ID was found in ${minifiedFileWithoutDebugId}`,
                ),
                'warn',
            );
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringMatching(/Done uploading .*1\/1.* sourcemaps/),
                'debug',
            );

            getPayloadSpy.mockRestore();
            rmSync(tempDir);
        });

        test('Should abort when all debug IDs are missing', async () => {
            const tempDir = path.join(os.tmpdir(), 'dd-build-plugins-no-debug-id');
            const minifiedFilePath = path.join(tempDir, 'app.js');
            const sourcemapFilePath = path.join(tempDir, 'app.js.map');
            const minifiedFileContent = 'console.log("no debug id");';
            const sourcemapContent = '{"version":3,"sources":["app.js"]}';
            outputFileSync(minifiedFilePath, minifiedFileContent);
            outputFileSync(sourcemapFilePath, sourcemapContent);
            addFixtureFiles({
                [minifiedFilePath]: minifiedFileContent,
                [sourcemapFilePath]: sourcemapContent,
            });
            const getPayloadSpy = jest.spyOn(payloadModule, 'getPayload');

            await sendSourcemaps(
                [getSourcemapMock({ minifiedFilePath, sourcemapFilePath })],
                getDebugIdSourcemapsConfiguration(),
                senderContextMock,
                mockLogger,
            );

            expect(getPayloadSpy).not.toHaveBeenCalled();
            expect(doRequestMock).not.toHaveBeenCalled();
            expect(mockLogFn).toHaveBeenCalledWith(
                'No debug ID found in any minified file. Aborting upload.',
                'error',
            );

            getPayloadSpy.mockRestore();
            rmSync(tempDir);
        });

        test('Should throw when all debug IDs are missing and bailOnError is enabled', async () => {
            const tempDir = path.join(os.tmpdir(), 'dd-build-plugins-no-debug-id-bail');
            const minifiedFilePath = path.join(tempDir, 'app.js');
            const sourcemapFilePath = path.join(tempDir, 'app.js.map');
            const minifiedFileContent = 'console.log("no debug id");';
            const sourcemapContent = '{"version":3,"sources":["app.js"]}';
            outputFileSync(minifiedFilePath, minifiedFileContent);
            outputFileSync(sourcemapFilePath, sourcemapContent);
            addFixtureFiles({
                [minifiedFilePath]: minifiedFileContent,
                [sourcemapFilePath]: sourcemapContent,
            });
            const getPayloadSpy = jest.spyOn(payloadModule, 'getPayload');

            await expect(
                sendSourcemaps(
                    [getSourcemapMock({ minifiedFilePath, sourcemapFilePath })],
                    { ...getDebugIdSourcemapsConfiguration(), bailOnError: true },
                    senderContextMock,
                    mockLogger,
                ),
            ).rejects.toThrow('No debug ID found in any minified file. Aborting upload.');

            expect(getPayloadSpy).not.toHaveBeenCalled();
            expect(doRequestMock).not.toHaveBeenCalled();

            getPayloadSpy.mockRestore();
            rmSync(tempDir);
        });

        test('Should not report missing debug IDs when no sourcemaps were found', async () => {
            await sendSourcemaps(
                [],
                getDebugIdSourcemapsConfiguration(),
                senderContextMock,
                mockLogger,
            );

            expect(doRequestMock).not.toHaveBeenCalled();
            expect(mockLogFn).not.toHaveBeenCalledWith(
                'No debug ID found in any minified file. Aborting upload.',
                'error',
            );
        });
    });

    describe('upload', () => {
        beforeEach(() => {
            doRequestMock.mockReset();
            jest.mocked(contextMock.addMetric).mockReset();

            // Add some fixtures.
            addFixtureFiles({
                '/path/to/minified.min.js': 'Some JS File with some content.',
                '/path/to/sourcemap.js.map': '{"version":3,"sources":["/path/to/minified.min.js"]}',
            });
        });

        test('Should not throw', async () => {
            doRequestMock.mockResolvedValue(undefined);

            const payloads = [getPayloadMock()];

            const { warnings, errors } = await upload(
                payloads,
                getSourcemapsConfiguration(),
                uploadContextMock,
                mockLogger,
            );

            expect(warnings).toHaveLength(0);
            expect(errors).toHaveLength(0);
            expect(doRequestMock).toHaveBeenCalledTimes(1);
        });

        test('Should alert in case of errors', async () => {
            doRequestMock.mockRejectedValueOnce(new Error('Fake Error'));

            const payloads = [getPayloadMock()];
            const { warnings, errors } = await upload(
                payloads,
                getSourcemapsConfiguration(),
                uploadContextMock,
                mockLogger,
            );

            expect(errors).toHaveLength(1);
            expect(errors[0]).toMatchObject({
                metadata: {
                    sourcemap: '/path/to/sourcemap.js.map',
                    file: '/path/to/minified.min.js',
                },
                error: new Error('Fake Error'),
            });
            expect(warnings).toHaveLength(0);
            expect(doRequestMock).toHaveBeenCalledTimes(1);
        });

        test('Should throw in case of errors with bailOnError', async () => {
            doRequestMock.mockRejectedValueOnce(new Error('Fake Error'));

            const payloads = [getPayloadMock()];
            await expect(
                upload(
                    payloads,
                    getSourcemapsConfiguration({ bailOnError: true }),
                    uploadContextMock,
                    mockLogger,
                ),
            ).rejects.toThrow('Fake Error');
        });

        test('Should add retry metrics for temporary upload failures', async () => {
            const retryError = new Error('HTTP 408 Request Timeout\nstream timeout');
            doRequestMock.mockImplementation(async (opts) => {
                opts.onRetry?.(retryError, 1);
            });

            const payloads = [getPayloadMock()];
            const { warnings, errors } = await upload(
                payloads,
                getSourcemapsConfiguration(),
                { ...uploadContextMock, sendMetrics: true },
                mockLogger,
            );

            expect(warnings).toHaveLength(1);
            expect(errors).toHaveLength(0);
            expect(doRequestMock).toHaveBeenCalledTimes(1);
            expect(uploadContextMock.addMetric).toHaveBeenCalledWith({
                metric: `${SOURCEMAP_UPLOAD_METRIC_PREFIX}.retry`,
                type: 'count',
                points: [[expect.any(Number), 1]],
                tags: expect.arrayContaining([
                    'service:error-tracking-build-plugin-sourcemaps',
                    'attempt:1',
                    'status_code:408',
                    'error_type:http_408',
                ]),
            });
        });

        test('Should add final failure metrics for exhausted upload retries', async () => {
            doRequestMock
                .mockRejectedValueOnce(new Error('HTTP 408 Request Timeout\nstream timeout'))
                .mockResolvedValueOnce(undefined);

            const payloads = [getPayloadMock()];
            const { warnings, errors } = await upload(
                payloads,
                getSourcemapsConfiguration(),
                { ...uploadContextMock, sendMetrics: true },
                mockLogger,
            );

            expect(warnings).toHaveLength(0);
            expect(errors).toHaveLength(1);
            expect(doRequestMock).toHaveBeenCalledTimes(1);
            expect(uploadContextMock.addMetric).toHaveBeenCalledWith({
                metric: `${SOURCEMAP_UPLOAD_METRIC_PREFIX}.failure`,
                type: 'count',
                points: [[expect.any(Number), 1]],
                tags: expect.arrayContaining([
                    'service:error-tracking-build-plugin-sourcemaps',
                    'status_code:408',
                    'error_type:http_408',
                ]),
            });
        });
    });
});
