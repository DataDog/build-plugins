// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { RequestOpts } from '@dd/core/types';
import { API_PATH, FAKE_URL, INTAKE_URL } from '@dd/tests/helpers/mocks';
import nock from 'nock';
import { Readable } from 'stream';
import { createGzip } from 'zlib';

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

describe('Core Helpers', () => {
    describe('formatDuration', () => {
        test.each([
            [10, '10ms'],
            [10010, '10s 10ms'],
            [1000010, '16m 40s 10ms'],
            [10000010, '2h 46m 40s 10ms'],
            [1000000010, '11d 13h 46m 40s 10ms'],
        ])('Should format duration %s => %s', async (ms, expected) => {
            const { formatDuration } = await import('@dd/core/helpers');
            expect(formatDuration(ms)).toBe(expected);
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

        const requestOpts: RequestOpts = {
            url: INTAKE_URL,
            method: 'POST',
            type: 'json',
            getData: getDataMock,
        };

        afterEach(() => {
            nock.cleanAll();
        });

        test('Should do a request', async () => {
            const { doRequest } = await import('@dd/core/helpers');
            const scope = nock(FAKE_URL).post(API_PATH).reply(200, {});

            const response = await doRequest(requestOpts);

            expect(scope.isDone()).toBe(true);
            expect(response).toEqual({});
        });

        test('Should retry on error', async () => {
            const { doRequest } = await import('@dd/core/helpers');
            // Success after 2 retries.
            const scope = nock(FAKE_URL)
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
            const { doRequest } = await import('@dd/core/helpers');
            const scope = nock(FAKE_URL)
                .post(API_PATH)
                .times(6)
                .reply(500, 'Internal Server Error');

            await expect(async () => {
                await doRequest(requestOpts);
            }).rejects.toThrow('HTTP 500 Internal Server Error');
            expect(scope.isDone()).toBe(true);
        });

        test('Should bail on specific status', async () => {
            const { doRequest } = await import('@dd/core/helpers');
            const scope = nock(FAKE_URL).post(API_PATH).reply(400, 'Bad Request');

            await expect(async () => {
                await doRequest(requestOpts);
            }).rejects.toThrow('HTTP 400 Bad Request');
            expect(scope.isDone()).toBe(true);
        });

        test('Should bail on unrelated errors', async () => {
            const { doRequest } = await import('@dd/core/helpers');
            const scope = nock(FAKE_URL).post(API_PATH).reply(404);
            // Creating the data stream outside should make the fetch invocation fail
            // on the second pass as it will try to read an already consumed stream.
            const data = getDataStream();

            await expect(async () => {
                await doRequest({ ...requestOpts, getData: () => ({ data, headers: {} }) });
            }).rejects.toThrow('Response body object should not be disturbed or locked');
            expect(scope.isDone()).toBe(true);
        });
    });

    describe('truncateString', () => {
        test.each([
            // No truncation needed.
            ['Short string', 20, '[...]', 'Short string'],
            // Keep at least 2 characters on each side.
            ['Short string', 2, '[...]', 'Sh[...]ng'],
            // Equaly truncate on both sides.
            [
                'A way too long sentence could be truncated a bit.',
                20,
                '[...]',
                'A way t[...]d a bit.',
            ],
            // Custom placeholder.
            [
                'A way too long sentence could be truncated a bit.',
                20,
                '***',
                'A way to***ed a bit.',
            ],
            // Longer sentence.
            [
                'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
                50,
                '[...]',
                'Lorem ipsu[...]t ut labore et dolore magna aliqua.',
            ],
        ])(
            'Should truncate string "%s" to max length %d with placeholder "%s" => "%s"',
            async (str, maxLength, placeholder, expected) => {
                const { truncateString } = await import('@dd/core/helpers');
                expect(truncateString(str, maxLength, placeholder)).toBe(expected);
            },
        );
    });
});
