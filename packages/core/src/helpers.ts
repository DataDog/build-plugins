// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import retry from 'async-retry';
import type { RequestInit } from 'undici-types';

import type { RequestOpts } from './types';

// Format a duration 0h 0m 0s 0ms
export const formatDuration = (duration: number) => {
    const days = Math.floor(duration / 1000 / 60 / 60 / 24);
    const usedDuration = duration - days * 24 * 60 * 60 * 1000;
    const d = new Date(usedDuration);
    const hours = d.getUTCHours();
    const minutes = d.getUTCMinutes();
    const seconds = d.getUTCSeconds();
    const milliseconds = d.getUTCMilliseconds();
    return `${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${minutes ? `${minutes}m ` : ''}${
        seconds ? `${seconds}s ` : ''
    }${milliseconds}ms`.trim();
};

export const getResolvedPath = (source: string) => {
    let resolvedPath = source;
    try {
        resolvedPath = require.resolve(source);
    } catch (e) {
        // No big deal.
    }
    return resolvedPath;
};

export const ERROR_CODES_NO_RETRY = [400, 403, 413];
export const NB_RETRIES = 5;
// Do a retriable fetch.
export const doRequest = <T>(opts: RequestOpts): Promise<T> => {
    const { url, method = 'GET', getData, onRetry, type = 'text' } = opts;
    return retry(
        async (bail: (e: Error) => void, attempt: number) => {
            let response: Response;
            try {
                const requestInit: RequestInit = {
                    method,
                    // This is needed for sending body in NodeJS' Fetch.
                    // https://github.com/nodejs/node/issues/46221
                    duplex: 'half',
                };

                if (typeof getData === 'function') {
                    const { data, headers } = await getData();
                    requestInit.body = data;
                    requestInit.headers = headers;
                }

                response = await fetch(url, requestInit);
            } catch (error: any) {
                // We don't want to retry if there is a non-fetch related error.
                bail(error);
                // bail(error) throws so the return is never executed.
                return {} as T;
            }

            if (!response.ok) {
                // Not instantiating the error here, as it will make Jest throw in the tests.
                const errorMessage = `HTTP ${response.status} ${response.statusText}`;
                if (ERROR_CODES_NO_RETRY.includes(response.status)) {
                    bail(new Error(errorMessage));
                    // bail(error) throws so the return is never executed.
                    return {} as T;
                } else {
                    // Trigger the retry.
                    throw new Error(errorMessage);
                }
            }

            try {
                let result;
                // Await it so we catch any parsing error and bail.
                if (type === 'json') {
                    result = await response.json();
                } else {
                    result = await response.text();
                }

                return result as T;
            } catch (error: any) {
                // We don't want to retry on parsing errors.
                bail(error);
                // bail(error) throws so the return is never executed.
                return {} as T;
            }
        },
        {
            retries: NB_RETRIES,
            onRetry,
        },
    );
};
