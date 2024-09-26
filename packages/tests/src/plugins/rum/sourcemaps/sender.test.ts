// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
import { doRequest } from '@dd/core/helpers';
import { getData, sendSourcemaps, upload } from '@dd/rum-plugins/sourcemaps/sender';
import { getContextMock } from '@dd/tests/helpers/mocks';
import { vol } from 'memfs';
import { type Stream } from 'stream';
import { unzipSync } from 'zlib';

import { getPayloadMock, getSourcemapMock, getSourcemapsConfiguration } from '../testHelpers';

jest.mock('fs', () => require('memfs').fs);

jest.mock('@dd/core/helpers', () => {
    const actualModule = jest.requireActual('@dd/core/helpers');
    return {
        ...actualModule,
        doRequest: jest.fn(),
    };
});

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

describe('RUM Plugin Sourcemaps', () => {
    describe('getData', () => {
        afterEach(() => {
            vol.reset();
        });
        test('Should return the correct data and headers', async () => {
            // Emulate some fixtures.
            vol.fromJSON(
                {
                    '/path/to/minified.min.js': 'Some JS File',
                    '/path/to/sourcemap.js.map':
                        '{"version":3,"sources":["/path/to/minified.min.js"]}',
                },
                __dirname,
            );

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
        afterEach(() => {
            vol.reset();
        });

        test('Should upload sourcemaps.', async () => {
            // Emulate some fixtures.
            vol.fromJSON(
                {
                    '/path/to/minified.min.js': 'Some JS File with some content.',
                    '/path/to/sourcemap.js.map':
                        '{"version":3,"sources":["/path/to/minified.min.js"]}',
                },
                __dirname,
            );

            await sendSourcemaps(
                [getSourcemapMock()],
                getSourcemapsConfiguration(),
                getContextMock(),
                () => {},
            );

            expect(doRequestMock).toHaveBeenCalledTimes(1);
        });

        test('Should alert in case of payload issues', async () => {
            // Emulate some fixtures.
            vol.fromJSON(
                {
                    // Empty file.
                    '/path/to/minified.min.js': '',
                },
                __dirname,
            );

            const logMock = jest.fn();

            await sendSourcemaps(
                [getSourcemapMock()],
                getSourcemapsConfiguration(),
                getContextMock(),
                logMock,
            );

            expect(logMock).toHaveBeenCalledTimes(1);
            expect(logMock).toHaveBeenCalledWith(
                expect.stringMatching('Failed to prepare payloads, aborting upload'),
                'error',
            );
            expect(doRequestMock).not.toHaveBeenCalled();
        });

        test('Should throw in case of payload issues and bailOnError', async () => {
            // Emulate some fixtures.
            vol.fromJSON(
                {
                    // Empty file.
                    '/path/to/minified.min.js': '',
                },
                __dirname,
            );

            await expect(async () => {
                await sendSourcemaps(
                    [getSourcemapMock()],
                    getSourcemapsConfiguration({ bailOnError: true }),
                    getContextMock(),
                    () => {},
                );
            }).rejects.toThrow('Failed to prepare payloads, aborting upload');
            expect(doRequestMock).not.toHaveBeenCalled();
        });
    });

    describe('upload', () => {
        beforeEach(() => {
            // Emulate some fixtures.
            vol.fromJSON(
                {
                    '/path/to/minified.min.js': 'Some JS File with some content.',
                    '/path/to/sourcemap.js.map':
                        '{"version":3,"sources":["/path/to/minified.min.js"]}',
                },
                __dirname,
            );
        });

        afterEach(() => {
            vol.reset();
        });

        test('Should not throw', async () => {
            doRequestMock.mockImplementation(jest.fn());

            const payloads = [getPayloadMock()];

            const { warnings, errors } = await upload(
                payloads,
                getSourcemapsConfiguration(),
                getContextMock(),
                () => {},
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
                getContextMock(),
                jest.fn(),
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
            expect(
                upload(
                    payloads,
                    getSourcemapsConfiguration({ bailOnError: true }),
                    getContextMock(),
                    () => {},
                ),
            ).rejects.toThrow('Fake Error');
        });
    });
});
