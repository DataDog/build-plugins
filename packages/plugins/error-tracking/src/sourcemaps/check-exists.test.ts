// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest } from '@dd/core/helpers/request';

import { getCheckExistsUrl, getExistingDebugIds, MAX_DEBUG_IDS_PER_REQUEST } from './check-exists';

jest.mock('@dd/core/helpers/request', () => {
    const original = jest.requireActual('@dd/core/helpers/request');
    return {
        ...original,
        doRequest: jest.fn(),
    };
});

const doRequestMock = jest.mocked(doRequest);

const contextMock = {
    apiKey: 'api-key',
    bundlerName: 'webpack',
    site: 'datadoghq.com',
    version: '1.0.0',
};

const getExpectedBody = (debugIds: string[]) =>
    JSON.stringify({ data: { type: 'check_exists', attributes: { debug_ids: debugIds } } });

const getRequestBody = async (callIndex: number) => {
    const opts = doRequestMock.mock.calls[callIndex][0];
    const requestData = await opts.getData!();
    const { data } = requestData;
    if (typeof data !== 'string') {
        throw new Error('Expected a JSON request body.');
    }

    return data;
};

describe('Error Tracking Plugin check-exists', () => {
    beforeEach(() => {
        doRequestMock.mockReset();
    });

    describe('getCheckExistsUrl', () => {
        test('Should point at the API of the given site', () => {
            expect(getCheckExistsUrl('us3.datadoghq.com')).toBe(
                'https://api.us3.datadoghq.com/api/unstable/sourcemaps/check_exists',
            );
        });
    });

    describe('getExistingDebugIds', () => {
        test('Should only report the debug IDs that already exist', async () => {
            doRequestMock.mockResolvedValue({
                data: { attributes: { results: { 'debug-id-1': true, 'debug-id-2': false } } },
            });

            const existing = await getExistingDebugIds(['debug-id-1', 'debug-id-2'], contextMock);

            expect([...existing]).toEqual(['debug-id-1']);
        });

        test('Should only count an explicit true as existing', async () => {
            doRequestMock.mockResolvedValue({
                data: { attributes: { results: { 'debug-id-1': 'false', 'debug-id-2': true } } },
            });

            const existing = await getExistingDebugIds(['debug-id-1', 'debug-id-2'], contextMock);

            expect([...existing]).toEqual(['debug-id-2']);
        });

        test('Should post a JSON:API body with the sourcemap origin headers', async () => {
            doRequestMock.mockResolvedValue({ data: { attributes: { results: {} } } });

            await getExistingDebugIds(['debug-id-1'], contextMock);

            expect(doRequestMock).toHaveBeenCalledTimes(1);
            const opts = doRequestMock.mock.calls[0][0];
            expect(opts.url).toBe('https://api.datadoghq.com/api/unstable/sourcemaps/check_exists');
            expect(opts.method).toBe('POST');
            expect(opts.retries).toBe(0);
            expect(opts.type).toBe('json');
            expect(opts.auth).toEqual({ apiKey: 'api-key' });
            expect(await getRequestBody(0)).toBe(getExpectedBody(['debug-id-1']));

            const { headers } = await opts.getData!();
            expect(headers).toEqual(
                expect.objectContaining({
                    'Content-Type': 'application/vnd.api+json',
                    'DD-EVP-ORIGIN': 'webpack-build-plugin_sourcemaps',
                    'DD-EVP-ORIGIN-VERSION': '1.0.0',
                }),
            );
        });

        test('Should deduplicate the debug IDs', async () => {
            doRequestMock.mockResolvedValue({ data: { attributes: { results: {} } } });

            await getExistingDebugIds(['debug-id-1', 'debug-id-1'], contextMock);

            expect(doRequestMock).toHaveBeenCalledTimes(1);
            expect(await getRequestBody(0)).toBe(getExpectedBody(['debug-id-1']));
        });

        test('Should not request anything without debug IDs', async () => {
            const existing = await getExistingDebugIds([], contextMock);

            expect([...existing]).toEqual([]);
            expect(doRequestMock).not.toHaveBeenCalled();
        });

        test('Should chunk the debug IDs across several requests', async () => {
            doRequestMock.mockResolvedValue({ data: { attributes: { results: {} } } });
            const debugIds = Array.from(
                { length: MAX_DEBUG_IDS_PER_REQUEST + 1 },
                (_, index) => `debug-id-${index}`,
            );

            await getExistingDebugIds(debugIds, contextMock);

            expect(doRequestMock).toHaveBeenCalledTimes(2);
            expect(await getRequestBody(0)).toBe(
                getExpectedBody(debugIds.slice(0, MAX_DEBUG_IDS_PER_REQUEST)),
            );
            expect(await getRequestBody(1)).toBe(
                getExpectedBody(debugIds.slice(MAX_DEBUG_IDS_PER_REQUEST)),
            );
        });

        test('Should throw when the request fails', async () => {
            doRequestMock.mockRejectedValue(new Error('HTTP 500 Internal Server Error'));

            await expect(getExistingDebugIds(['debug-id-1'], contextMock)).rejects.toThrow(
                'HTTP 500 Internal Server Error',
            );
        });

        test('Should throw when the response carries no results', async () => {
            doRequestMock.mockResolvedValue({});

            await expect(getExistingDebugIds(['debug-id-1'], contextMock)).rejects.toThrow(
                'Invalid check_exists response: missing results.',
            );
        });
    });
});
