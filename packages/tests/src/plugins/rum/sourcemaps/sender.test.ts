// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest, getData, sendSourcemaps, upload } from '@dd/rum-plugins/sourcemaps/sender';
import { getContextMock } from '@dd/tests/helpers/mocks';
import retry from 'async-retry';
import { vol } from 'memfs';
import nock from 'nock';
import { Readable, type Stream } from 'stream';
import { createGzip, unzipSync } from 'zlib';

import {
    API_PATH,
    FAKE_URL,
    INTAKE_URL,
    getPayloadMock,
    getSourcemapMock,
    getSourcemapsConfiguration,
} from '../testHelpers';

jest.mock('fs', () => require('memfs').fs);

// Reduce the retry timeout to speed up the tests.
jest.mock('async-retry', () => {
    const original = jest.requireActual('async-retry');
    return jest.fn((callback, options) => {
        return original(callback, {
            ...options,
            minTimeout: 0,
            maxTimeout: 1,
        });
    });
});

const retryMock = jest.mocked(retry);

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
        test('It should return the correct data and headers', async () => {
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
        afterEach(async () => {
            nock.cleanAll();
            vol.reset();
        });

        test('It should upload sourcemaps.', async () => {
            const scope = nock(FAKE_URL).post(API_PATH).reply(200, {});
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

            expect(scope.isDone()).toBe(true);
        });

        test('It should alert in case of payload issues', async () => {
            const scope = nock(FAKE_URL).post(API_PATH).reply(200);
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
            expect(scope.isDone()).toBe(false);
        });

        test('It should throw in case of payload issues and bailOnError', async () => {
            const scope = nock(FAKE_URL).post(API_PATH).reply(200);
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

            expect(scope.isDone()).toBe(false);
        });
    });

    describe('doRequest', () => {
        const getDataStream = () => {
            const gz = createGzip();
            const stream = new Readable();
            stream.push('Some data');
            stream.push(null);
            return stream.pipe(gz);
        };
        const getDataMock = () => ({
            data: getDataStream(),
            headers: {
                'Content-Encoding': 'gzip',
            },
        });

        afterEach(() => {
            nock.cleanAll();
        });

        test('It should do a request', async () => {
            const scope = nock(FAKE_URL).post(API_PATH).reply(200, {});

            const response = await doRequest(INTAKE_URL, getDataMock);

            expect(scope.isDone()).toBe(true);
            expect(response).toEqual({});
        });

        test('It should retry on error', async () => {
            // Success after 2 retries.
            const scope = nock(FAKE_URL)
                .post(API_PATH)
                .times(2)
                .reply(404)
                .post(API_PATH)
                .reply(200, { data: 'ok' });

            const response = await doRequest(INTAKE_URL, getDataMock);

            expect(scope.isDone()).toBe(true);
            expect(response).toEqual({ data: 'ok' });
        });

        test('It should throw on too many retries', async () => {
            const scope = nock(FAKE_URL)
                .post(API_PATH)
                .times(6)
                .reply(500, 'Internal Server Error');

            await expect(async () => {
                await doRequest(INTAKE_URL, getDataMock);
            }).rejects.toThrow('HTTP 500 Internal Server Error');
            expect(scope.isDone()).toBe(true);
        });

        test('It should bail on specific status', async () => {
            const scope = nock(FAKE_URL).post(API_PATH).reply(400, 'Bad Request');

            await expect(async () => {
                await doRequest(INTAKE_URL, getDataMock);
            }).rejects.toThrow('HTTP 400 Bad Request');
            expect(scope.isDone()).toBe(true);
        });

        test('It should bail on unrelated errors', async () => {
            const scope = nock(FAKE_URL).post(API_PATH).reply(404);
            // Creating the data stream outside should make the fetch invocation fail
            // on the second pass as it will try to read an already consumed stream.
            const data = getDataStream();

            await expect(async () => {
                await doRequest(INTAKE_URL, () => ({ data, headers: {} }));
            }).rejects.toThrow('Response body object should not be disturbed or locked');
            expect(scope.isDone()).toBe(true);
        });
    });

    describe('upload', () => {
        test('It should not throw', async () => {
            retryMock.mockImplementation(jest.fn());

            const payloads = [getPayloadMock()];

            const { warnings, errors } = await upload(
                payloads,
                getSourcemapsConfiguration(),
                getContextMock(),
                () => {},
            );

            expect(warnings).toHaveLength(0);
            expect(errors).toHaveLength(0);
        });

        test('It should alert in case of errors', async () => {
            retryMock.mockRejectedValue(new Error('Fake Error'));

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
                    sourcemap: expect.any(String),
                    file: expect.any(String),
                },
                error: new Error('Fake Error'),
            });
            expect(warnings).toHaveLength(0);
        });

        test('It should throw in case of errors with bailOnError', async () => {
            retryMock.mockRejectedValue(new Error('Fake Error'));

            const payloads = [getPayloadMock()];
            expect(async () => {
                await upload(
                    payloads,
                    getSourcemapsConfiguration({ bailOnError: true }),
                    getContextMock(),
                    () => {},
                );
            }).rejects.toThrow('Fake Error');
        });
    });
});
