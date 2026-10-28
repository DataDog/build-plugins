// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { DEFAULT_SITE } from '@dd/core/constants';
import type { RequestOpts } from '@dd/core/types';
import {
    SOURCEMAPS_API_PATH,
    SOURCEMAPS_API_SUBDOMAIN,
    getIntakeUrl,
} from '@dd/error-tracking-plugin/sourcemaps/sender';
import nock from 'nock';
import { Readable } from 'stream';
import { createGzip } from 'zlib';

const API_PATH = `/${SOURCEMAPS_API_PATH}`;
const API_URL = `https://${SOURCEMAPS_API_SUBDOMAIN}.${DEFAULT_SITE}`;

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
            url: getIntakeUrl(DEFAULT_SITE),
            method: 'POST',
            type: 'json',
            getData: getDataMock,
        };

        afterEach(() => {
            nock.cleanAll();
            jest.restoreAllMocks();
            jest.clearAllMocks();
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
                .reply(503)
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

        test('Should include JSON API error details in message', async () => {
            const { doRequest } = await import('@dd/core/helpers/request');
            const scope = nock(API_URL)
                .post(API_PATH)
                .reply(404, {
                    errors: [
                        {
                            status: '404',
                            id: '96c4b47f-d967-41d5-8d66-a1d6782118ae',
                            title: 'app not found',
                            detail: 'app with id dd3cc768-529c-48bc-9ffb-f42775a5348a not found',
                        },
                    ],
                });

            await expect(async () => {
                await doRequest({ ...requestOpts, retries: 0 });
            }).rejects.toThrow(
                'HTTP 404 Not Found\nstatus: 404, id: 96c4b47f-d967-41d5-8d66-a1d6782118ae, title: app not found, detail: app with id dd3cc768-529c-48bc-9ffb-f42775a5348a not found',
            );
            expect(scope.isDone()).toBe(true);
        });

        test('Should include JSON API error title when detail is absent', async () => {
            const { doRequest } = await import('@dd/core/helpers/request');
            const scope = nock(API_URL)
                .post(API_PATH)
                .reply(404, { errors: [{ title: 'app not found' }] });

            await expect(async () => {
                await doRequest({ ...requestOpts, retries: 0 });
            }).rejects.toThrow('HTTP 404 Not Found\ntitle: app not found');
            expect(scope.isDone()).toBe(true);
        });

        test('Should include multiple JSON API errors in message', async () => {
            const { doRequest } = await import('@dd/core/helpers/request');
            const scope = nock(API_URL)
                .post(API_PATH)
                .reply(404, {
                    errors: [
                        { title: 'app not found', detail: 'app with id abc not found' },
                        { title: 'permission denied', detail: 'user lacks required scope' },
                    ],
                });

            await expect(async () => {
                await doRequest({ ...requestOpts, retries: 0 });
            }).rejects.toThrow(
                'HTTP 404 Not Found\ntitle: app not found, detail: app with id abc not found\ntitle: permission denied, detail: user lacks required scope',
            );
            expect(scope.isDone()).toBe(true);
        });

        test('Should include JSON API error detail when title is absent', async () => {
            const { doRequest } = await import('@dd/core/helpers/request');
            const scope = nock(API_URL)
                .post(API_PATH)
                .reply(404, { errors: [{ detail: 'something went wrong' }] });

            await expect(async () => {
                await doRequest({ ...requestOpts, retries: 0 });
            }).rejects.toThrow('HTTP 404 Not Found\ndetail: something went wrong');
            expect(scope.isDone()).toBe(true);
        });

        test('Should include JSON API error fields beyond title and detail', async () => {
            const { doRequest } = await import('@dd/core/helpers/request');
            const scope = nock(API_URL)
                .post(API_PATH)
                .reply(403, {
                    errors: [
                        {
                            status: '403',
                            code: 'forbidden',
                            title: 'access denied',
                            detail: 'user lacks required scope',
                            meta: { requiredScope: 'apps_write' },
                        },
                    ],
                });

            await expect(async () => {
                await doRequest({ ...requestOpts, retries: 0 });
            }).rejects.toThrow(
                'HTTP 403 Forbidden\nstatus: 403, code: forbidden, title: access denied, detail: user lacks required scope, meta: {"requiredScope":"apps_write"}',
            );
            expect(scope.isDone()).toBe(true);
        });

        test('Should eventually fail when getData reuses a consumed stream', async () => {
            const { doRequest } = await import('@dd/core/helpers/request');
            const scope = nock(API_URL).post(API_PATH).reply(503);
            // Creating the data stream outside should make the fetch invocation fail
            // on the second pass as it will try to read an already consumed stream.
            const data = getDataStream();

            await expect(async () => {
                await doRequest({
                    ...requestOpts,
                    retries: 2,
                    minTimeout: 1,
                    maxTimeout: 1,
                    getData: () => ({ data, headers: {} }),
                });
            }).rejects.toThrow('Response body object should not be disturbed or locked');
            expect(scope.isDone()).toBe(true);
        });

        test.each([undefined, false])(
            'Should not replay a POST when retryFetchErrors is %s',
            async (retryFetchErrors) => {
                const { doRequest } = await import('@dd/core/helpers/request');
                const error = new TypeError('fetch failed', {
                    cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
                });
                const fetchImpl = jest.fn().mockRejectedValue(error);
                const onRetry = jest.fn();

                await expect(
                    doRequest({
                        ...requestOpts,
                        retryFetchErrors,
                        fetchImpl,
                        onRetry,
                        minTimeout: 1,
                        maxTimeout: 1,
                    }),
                ).rejects.toBe(error);
                expect(fetchImpl).toHaveBeenCalledTimes(1);
                expect(onRetry).not.toHaveBeenCalled();
            },
        );

        test.each(['ECONNRESET', 'EPIPE', 'UNKNOWN_NETWORK_CODE'])(
            'Should recover from fetch network error %s',
            async (code) => {
                const { doRequest } = await import('@dd/core/helpers/request');
                const onRetryMock = jest.fn();
                const connResetCause = Object.assign(new Error(`write ${code}`), { code });
                const fetchFailedError = Object.assign(new TypeError('fetch failed'), {
                    cause: connResetCause,
                });
                const fetchImpl = jest
                    .fn()
                    .mockRejectedValueOnce(fetchFailedError)
                    .mockResolvedValueOnce(new Response('{"data":"ok"}'));

                const response = await doRequest({
                    ...requestOpts,
                    retries: 2,
                    retryFetchErrors: true,
                    minTimeout: 1,
                    maxTimeout: 5,
                    onRetry: onRetryMock,
                    fetchImpl,
                });

                expect(response).toEqual({ data: 'ok' });
                expect(fetchImpl).toHaveBeenCalledTimes(2);
                expect(onRetryMock).toHaveBeenCalledTimes(1);
                expect(onRetryMock).toHaveBeenCalledWith(fetchFailedError, 1);
            },
        );

        test.each(['AbortError', 'TimeoutError'])(
            'Should bail on %s without an aborted signal',
            async (name) => {
                const { doRequest } = await import('@dd/core/helpers/request');
                const error = Object.assign(new Error('cancelled'), { name });
                const fetchImpl = jest.fn().mockRejectedValue(error);
                const onRetry = jest.fn();

                await expect(
                    doRequest({
                        url: API_URL,
                        retryFetchErrors: true,
                        fetchImpl,
                        onRetry,
                        minTimeout: 1,
                        maxTimeout: 1,
                    }),
                ).rejects.toBe(error);
                expect(fetchImpl).toHaveBeenCalledTimes(1);
                expect(onRetry).not.toHaveBeenCalled();
            },
        );

        test.each([
            'CERT_HAS_EXPIRED',
            'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
            'DEPTH_ZERO_SELF_SIGNED_CERT',
            'ENOTFOUND',
            'UND_ERR_INVALID_ARG',
            'UND_ERR_NOT_SUPPORTED',
            'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
            'UNKNOWN_NETWORK_CODE',
            undefined,
        ])('Should use bounded retries for fetch failed with cause %s', async (code) => {
            const { doRequest } = await import('@dd/core/helpers/request');
            const error = new TypeError('fetch failed');
            if (code) {
                Object.assign(error, { cause: Object.assign(new Error(code), { code }) });
            }
            const fetchImpl = jest.fn().mockRejectedValue(error);
            const onRetry = jest.fn();

            await expect(
                doRequest({
                    url: API_URL,
                    fetchImpl,
                    onRetry,
                    retryFetchErrors: true,
                    retries: 2,
                    minTimeout: 1,
                    maxTimeout: 1,
                }),
            ).rejects.toBe(error);
            expect(fetchImpl).toHaveBeenCalledTimes(3);
            expect(onRetry).toHaveBeenCalledTimes(2);
        });

        test('Should bail on getData rejection even with a transient error code', async () => {
            const { doRequest } = await import('@dd/core/helpers/request');
            const error = Object.assign(new Error('preparation failed'), { code: 'ECONNRESET' });
            const getData = jest.fn().mockRejectedValue(error);
            const fetchImpl = jest.fn();
            const onRetry = jest.fn();

            await expect(
                doRequest({
                    url: API_URL,
                    retryFetchErrors: true,
                    getData,
                    fetchImpl,
                    onRetry,
                    minTimeout: 1,
                    maxTimeout: 1,
                }),
            ).rejects.toBe(error);
            expect(getData).toHaveBeenCalledTimes(1);
            expect(fetchImpl).not.toHaveBeenCalled();
            expect(onRetry).not.toHaveBeenCalled();
        });

        test('Should bail without retrying when AbortSignal is aborted', async () => {
            const { doRequest } = await import('@dd/core/helpers/request');
            const onRetryMock = jest.fn();
            const controller = new AbortController();
            controller.abort();
            const abortError = Object.assign(new Error('The operation was aborted'), {
                name: 'AbortError',
            });
            const fetchImpl = jest.fn().mockRejectedValue(abortError);

            await expect(
                doRequest({
                    ...requestOpts,
                    retries: 3,
                    retryFetchErrors: true,
                    signal: controller.signal,
                    onRetry: onRetryMock,
                    fetchImpl,
                }),
            ).rejects.toThrow('The operation was aborted');

            expect(fetchImpl).toHaveBeenCalledTimes(1);
            expect(onRetryMock).not.toHaveBeenCalled();
        });

        test('Should add authentication headers when using API and APP keys.', async () => {
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
                getIntakeUrl(DEFAULT_SITE),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        // Coming from the requestOpts.auth.
                        'DD-API-KEY': 'api_key',
                        'DD-APPLICATION-KEY': 'app_key',
                    }),
                }),
            );
        });

        test('Should add bearer authentication headers when using an OAuth access token.', async () => {
            const fetchMock = jest
                .spyOn(global, 'fetch')
                .mockImplementation(() => Promise.resolve(new Response('{}')));
            const { doRequest } = await import('@dd/core/helpers/request');
            await doRequest({
                ...requestOpts,
                auth: {
                    accessToken: 'access-token',
                },
            });

            expect(fetchMock).toHaveBeenCalledWith(
                getIntakeUrl(DEFAULT_SITE),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer access-token',
                    }),
                }),
            );
        });

        test('Should use fetchImpl instead of the global fetch when provided', async () => {
            const globalFetch = jest.spyOn(global, 'fetch');
            const fetchImpl = jest.fn().mockResolvedValue(new Response('{"data":"ok"}'));
            const { doRequest } = await import('@dd/core/helpers/request');

            const response = await doRequest({ ...requestOpts, type: 'json', fetchImpl });

            expect(response).toEqual({ data: 'ok' });
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            expect(globalFetch).not.toHaveBeenCalled();
        });

        test('Should not add bearer authentication headers when the OAuth access token is empty.', async () => {
            const fetchMock = jest
                .spyOn(global, 'fetch')
                .mockImplementation(() => Promise.resolve(new Response('{}')));
            const { doRequest } = await import('@dd/core/helpers/request');
            await doRequest({
                ...requestOpts,
                auth: {
                    accessToken: '',
                },
            });

            expect(fetchMock).toHaveBeenCalledWith(
                getIntakeUrl(DEFAULT_SITE),
                expect.objectContaining({
                    headers: expect.not.objectContaining({
                        Authorization: expect.any(String),
                    }),
                }),
            );
        });
    });

    describe('isRetriableFetchError', () => {
        test.each([
            'ECONNRESET',
            'EPIPE',
            'ETIMEDOUT',
            'ECONNREFUSED',
            'ECONNABORTED',
            'EHOSTUNREACH',
            'ENETUNREACH',
            'EAI_AGAIN',
            'UND_ERR_SOCKET',
            'UND_ERR_CONNECT_TIMEOUT',
            'UND_ERR_HEADERS_TIMEOUT',
            'UND_ERR_BODY_TIMEOUT',
            'UND_ERR_CLOSED',
        ])('accepts transient code %s directly or as a cause', async (code) => {
            const { isRetriableFetchError } = await import('@dd/core/helpers/request');
            const error = Object.assign(new Error('network failure'), { code });
            expect(isRetriableFetchError(error)).toBe(true);
            expect(isRetriableFetchError(new Error('wrapped', { cause: error }))).toBe(true);
        });
    });

    describe('createRequestData', () => {
        test.each([true, false])(
            'Should materialize a valid multipart body with zip=%s',
            async (zip) => {
                const { createRequestData } = await import('@dd/core/helpers/request');

                const { data, headers } = await createRequestData({
                    getForm: () => {
                        const form = new FormData();
                        form.append(
                            'event',
                            new Blob([JSON.stringify({ service: 'web-ui' })], {
                                type: 'application/json',
                            }),
                            'event',
                        );
                        return form;
                    },
                    defaultHeaders: { 'DD-EVP-ORIGIN': 'rspack-build-plugin_sourcemaps' },
                    zip,
                });

                expect(headers['Content-Encoding']).toBe(zip ? 'gzip' : 'multipart/form-data');
                expect(headers['DD-EVP-ORIGIN']).toBe('rspack-build-plugin_sourcemaps');
                expect(Number(headers['Content-Length'])).toBeGreaterThan(0);

                const bytes = new Uint8Array(await new Response(data).arrayBuffer());
                expect(String(bytes.byteLength)).toBe(headers['Content-Length']);
                const body = new Blob([bytes]).stream();
                const decodedBody = zip ? body.pipeThrough(new DecompressionStream('gzip')) : body;
                const form = await new Response(decodedBody, {
                    headers: { 'Content-Type': headers['content-type'] },
                }).formData();
                const event = form.get('event') as File;
                expect(event.name).toBe('event');
                expect(JSON.parse(await event.text())).toEqual({ service: 'web-ui' });
            },
        );
    });
});
