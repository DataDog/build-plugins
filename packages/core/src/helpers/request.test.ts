// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { RequestOpts } from '@dd/core/types';
import {
    SOURCEMAPS_API_PATH,
    SOURCEMAPS_API_SUBDOMAIN,
    getIntakeUrl,
} from '@dd/error-tracking-plugin/sourcemaps/sender';
import { FAKE_SITE } from '@dd/tests/_jest/helpers/mocks';
import nock from 'nock';
import { Readable } from 'stream';
import { createGzip } from 'zlib';

const API_PATH = `/${SOURCEMAPS_API_PATH}`;
const API_URL = `https://${SOURCEMAPS_API_SUBDOMAIN}.${FAKE_SITE}`;

describe('Request Helpers', () => {
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

        const requestOpts: RequestOpts = {
            url: getIntakeUrl(FAKE_SITE),
            method: 'POST',
            type: 'json',
            getData: getDataMock,
        };

        afterEach(() => {
            nock.cleanAll();
        });

        test('Should do a request', async () => {
            const { doRequest } = await import('@dd/core/helpers/request');
            const scope = nock(API_URL).post(API_PATH).reply(200, {});

            const response = await doRequest(requestOpts);

            expect(scope.isDone()).toBe(true);
            expect(response).toEqual({});
        });

        test('Should retry on error', async () => {
            const { doRequest } = await import('@dd/core/helpers/request');
            // Success after 2 retries.
            const scope = nock(API_URL)
                .post(API_PATH)
                .times(2)
                .reply(404)
                .post(API_PATH)
                .reply(200, { data: 'ok' });

            const response = await doRequest(requestOpts);

            expect(scope.isDone()).toBe(true);
            expect(response).toEqual({ data: 'ok' });
        });

        test('Should throw on too many retries', async () => {
            const { doRequest } = await import('@dd/core/helpers/request');
            const scope = nock(API_URL).post(API_PATH).times(6).reply(500, 'Internal Server Error');

            await expect(async () => {
                await doRequest(requestOpts);
            }).rejects.toThrow('HTTP 500 Internal Server Error');
            expect(scope.isDone()).toBe(true);
        });

        test('Should respect retry options.', async () => {
            const { doRequest } = await import('@dd/core/helpers/request');
            const onRetryMock = jest.fn();
            const scope = nock(API_URL)
                .post(API_PATH)
                .reply(500, 'Internal Server Error')
                .post(API_PATH)
                .reply(200, { data: 'ok' });

            // TODO: Test maxTimeout and minTimeout
            await doRequest({ ...requestOpts, retries: 2, onRetry: onRetryMock });

            expect(onRetryMock).toHaveBeenCalledTimes(1);
            expect(scope.isDone()).toBe(true);
        });

        test('Should bail on specific status', async () => {
            const { doRequest } = await import('@dd/core/helpers/request');
            const scope = nock(API_URL).post(API_PATH).reply(400, 'Bad Request');

            await expect(async () => {
                await doRequest(requestOpts);
            }).rejects.toThrow('HTTP 400 Bad Request');
            expect(scope.isDone()).toBe(true);
        });

        test('Should bail on unrelated errors', async () => {
            const { doRequest } = await import('@dd/core/helpers/request');
            const scope = nock(API_URL).post(API_PATH).reply(404);
            // Creating the data stream outside should make the fetch invocation fail
            // on the second pass as it will try to read an already consumed stream.
            const data = getDataStream();

            await expect(async () => {
                await doRequest({ ...requestOpts, getData: () => ({ data, headers: {} }) });
            }).rejects.toThrow('Response body object should not be disturbed or locked');
            expect(scope.isDone()).toBe(true);
        });

        test('Should add authentication headers when needed.', async () => {
            const fetchMock = jest
                .spyOn(global, 'fetch')
                .mockImplementation(() => Promise.resolve(new Response('{}')));
            const { doRequest } = await import('@dd/core/helpers/request');
            await doRequest({
                ...requestOpts,
                auth: {
                    apiKey: 'api_key',
                    appKey: 'app_key',
                },
            });

            expect(fetchMock).toHaveBeenCalledWith(
                getIntakeUrl(FAKE_SITE),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        // Coming from the requestOpts.auth.
                        'DD-API-KEY': 'api_key',
                        'DD-APPLICATION-KEY': 'app_key',
                    }),
                }),
            );
        });
    });
});
