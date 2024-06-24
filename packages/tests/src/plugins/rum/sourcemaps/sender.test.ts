// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest, sendSourcemaps } from '@dd/rum-plugins/sourcemaps/sender';
import { getContextMock, getFetchMock } from '@dd/tests/helpers';
import { vol } from 'memfs';
import { createGzip } from 'zlib';

import { getSourcemapMock, getSourcemapsConfiguration } from '../testHelpers';

global.fetch = jest.fn(() => {
    return getFetchMock();
});

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

const fetchMocked = jest.mocked(fetch);

describe('RUM Plugin Sourcemaps', () => {
    describe('sendSourcemaps', () => {
        afterEach(() => {
            // Using a setTimeout because it creates an error on the ReadStreams created for the payloads.
            setTimeout(() => {
                vol.reset();
            }, 100);
        });

        test('It should upload sourcemaps.', async () => {
            // Emulate some fixtures.
            vol.fromJSON(
                {
                    '/path/to/minified.min.js': 'Some JS File',
                    '/path/to/sourcemap.js.map':
                        '{"version":3,"sources":["/path/to/minified.min.js"]}',
                },
                __dirname,
            );
            await sendSourcemaps(
                [getSourcemapMock()],
                getSourcemapsConfiguration({
                    basePath: __dirname,
                }),
                getContextMock(),
                () => {},
            );
            expect(fetchMocked).toHaveBeenCalledTimes(1);
        });

        test('It should throw in case of payload issues', async () => {
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
                    getSourcemapsConfiguration({
                        basePath: __dirname,
                    }),
                    getContextMock(),
                    () => {},
                );
            }).rejects.toThrow('Failed to upload sourcemaps:');
            expect(fetchMocked).not.toHaveBeenCalled();
        });
    });

    describe('doRequest', () => {
        const gz = createGzip();

        test('It should do a request', async () => {
            const response = await doRequest('https://example.com', gz, {});
            expect(fetchMocked).toHaveBeenCalled();
            expect(response).toEqual({});
        });

        test('It should retry on error', async () => {
            let retries = 0;
            fetchMocked.mockImplementation(() => {
                // Make it not fail on the fifth call.
                if (retries >= 4) {
                    return getFetchMock();
                }
                retries++;
                return getFetchMock({ ok: false });
            });
            const response = await doRequest('random_url', gz, {});
            expect(fetchMocked).toHaveBeenCalledTimes(5);
            expect(response).toEqual({});

            fetchMocked.mockClear();
        });

        test('It should throw on too many retries', async () => {
            fetchMocked.mockImplementation(() => {
                return getFetchMock({
                    ok: false,
                    status: 500,
                    statusText: 'Internal Server Error',
                });
            });

            await expect(async () => {
                await doRequest('random_url', gz, {});
            }).rejects.toThrow('HTTP 500 Internal Server Error');
            expect(fetchMocked).toHaveBeenCalledTimes(6);

            fetchMocked.mockClear();
        });

        test('It should bail on specific status', async () => {
            fetchMocked.mockImplementation(() => {
                return getFetchMock({ ok: false, status: 400, statusText: 'Bad Request' });
            });

            await expect(async () => {
                await doRequest('random_url', gz, {});
            }).rejects.toThrow('HTTP 400 Bad Request');
            expect(fetchMocked).toHaveBeenCalledTimes(1);

            fetchMocked.mockClear();
        });

        test('It should bail on unrelated errors', async () => {
            fetchMocked.mockImplementation(() => {
                throw new Error('Random error');
            });

            await expect(async () => {
                await doRequest('random_url', gz, {});
            }).rejects.toThrow('Random error');
            expect(fetchMocked).toHaveBeenCalledTimes(1);

            fetchMocked.mockClear();
        });
    });

    describe('upload', () => {
        // Not sure what to test here.
        // It's mostly an assemblage of every other functions.
    });
});
