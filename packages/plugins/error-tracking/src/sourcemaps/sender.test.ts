// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest } from '@dd/core/helpers/request';
import { getData, sendSourcemaps, upload } from '@dd/error-tracking-plugin/sourcemaps/sender';
import {
    getContextMock,
    mockLogFn,
    mockLogger,
    getPayloadMock,
    getSourcemapMock,
    getSourcemapsConfiguration,
    addFixtureFiles,
} from '@dd/tests/_jest/helpers/mocks';
import { type Stream } from 'stream';
import { unzipSync } from 'zlib';

jest.mock('@dd/core/helpers/fs', () => {
    const original = jest.requireActual('@dd/core/helpers/fs');
    return {
        ...original,
        checkFile: jest.fn(),
        getFile: jest.fn(),
    };
});

jest.mock('@dd/core/helpers/request', () => ({
    doRequest: jest.fn(),
}));

const doRequestMock = jest.mocked(doRequest);

function readFully(stream: Stream): Promise<Buffer> {
    const chunks: any[] = [];
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(chunk));

        stream.on('end', () => {
            resolve(Buffer.concat(chunks));
        });

        stream.on('error', reject);
    });
}

const contextMock = getContextMock();
const uploadContextMock = {
    apiKey: contextMock.auth?.apiKey,
    bundlerName: contextMock.bundler.fullName,
    version: contextMock.version,
    outDir: contextMock.bundler.outDir,
};
const senderContextMock = {
    ...uploadContextMock,
    git: contextMock.git,
};

describe('Error Tracking Plugin Sourcemaps', () => {
    describe('getData', () => {
        test('Should return the correct data and headers', async () => {
            // Add some fixtures.
            addFixtureFiles({
                '/path/to/minified.min.js': 'Some JS File with some content.',
                '/path/to/sourcemap.js.map': '{"version":3,"sources":["/path/to/minified.min.js"]}',
            });

            const payload = getPayloadMock();

            const { data, headers } = await getData(payload)();
            const zippedData = await readFully(data);
            const unzippedData = unzipSync(zippedData).toString('utf-8');
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

            expect(mockLogFn).toHaveBeenCalledTimes(1);
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
    });

    describe('upload', () => {
        beforeEach(() => {
            // Add some fixtures.
            addFixtureFiles({
                '/path/to/minified.min.js': 'Some JS File with some content.',
                '/path/to/sourcemap.js.map': '{"version":3,"sources":["/path/to/minified.min.js"]}',
            });
        });

        test('Should not throw', async () => {
            doRequestMock.mockImplementation(jest.fn());

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
            doRequestMock.mockRejectedValue(new Error('Fake Error'));

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
        });

        test('Should throw in case of errors with bailOnError', async () => {
            doRequestMock.mockRejectedValue(new Error('Fake Error'));

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
    });
});
