// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import retry from 'async-retry';
import type { RequestInit } from 'undici-types';

import type { RequestOpts } from '../types';

const formatErrorEntry = (e: unknown): string => {
    if (e === null || typeof e !== 'object') {
        return '';
    }
    return Object.entries(e)
        .map(
            ([key, value]) =>
                `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
        )
        .join(', ');
};

const parseErrorDetails = (bodyText: string): string => {
    try {
        const body: unknown = JSON.parse(bodyText);
        if (body !== null && typeof body === 'object') {
            if ('errors' in body && Array.isArray(body.errors)) {
                const details = body.errors
                    .map(formatErrorEntry)
                    .filter((s) => s.length > 0)
                    .join('\n');
                if (details) {
                    return details;
                }
            } else {
                const entry = formatErrorEntry(body);
                if (entry) {
                    return entry;
                }
            }
        }
    } catch {
        // Body is not JSON.
    }
    return bodyText;
};

export const getOriginHeaders = (opts: { bundler: string; plugin: string; version: string }) => {
    return {
        'DD-EVP-ORIGIN': `${opts.bundler}-build-plugin_${opts.plugin}`,
        'DD-EVP-ORIGIN-VERSION': opts.version,
    };
};

export type RequestData = {
    data: ReadableStream;
    headers: Record<string, string>;
};

export type FormBuilder = () => Promise<FormData> | FormData;

export const createRequestData = async (options: {
    getForm: FormBuilder;
    defaultHeaders: Record<string, string>;
    zip?: boolean;
}): Promise<RequestData> => {
    const { getForm, defaultHeaders = {}, zip = true } = options;
    const form = await getForm();

    // Serialize FormData through Request to get a streaming body
    // and auto-generated headers (boundary) that we can forward while piping through gzip.
    const req = new Request('fake://url', { method: 'POST', body: form });

    // Use Web Streams pipeThrough instead of Node.js pipe() to keep the pipeline lazy.
    // Node.js pipe() immediately puts the source into flowing mode (starts reading blobs
    // via process.nextTick), which races with cleanup of file-backed blobs after the
    // request completes. Web Streams only start reading when the output is consumed.
    const data = zip ? req.body!.pipeThrough(new CompressionStream('gzip')) : req.body!;

    const headers = {
        'Content-Encoding': zip ? 'gzip' : 'multipart/form-data',
        ...defaultHeaders,
        ...Object.fromEntries(req.headers.entries()),
    };

    return { data, headers };
};

export const ERROR_CODES_NO_RETRY = [400, 401, 403, 404, 405, 409, 413];
export const NB_RETRIES = 5;

// Do a retriable fetch.
export const doRequest = async <T>(opts: RequestOpts): Promise<T> => {
    const { auth, url, method = 'GET', getData, type = 'text' } = opts;
    const retryOpts: retry.Options = {
        retries: opts.retries === 0 ? 0 : opts.retries || NB_RETRIES,
        onRetry: opts.onRetry,
        maxTimeout: opts.maxTimeout,
        minTimeout: opts.minTimeout,
    };

    return retry(async (bail: (e: Error) => void, attempt: number) => {
        let response: Response;
        try {
            const requestInit: RequestInit = {
                method,
                // This is needed for sending body in NodeJS' Fetch.
                // https://github.com/nodejs/node/issues/46221
                duplex: 'half',
            };
            let requestHeaders: RequestInit['headers'] = {
                'X-Datadog-Origin': 'build-plugins',
            };

            // Do auth if present.
            if (auth && 'accessToken' in auth) {
                if (auth.accessToken) {
                    requestHeaders.Authorization = `Bearer ${auth.accessToken}`;
                }
            } else {
                if (auth?.apiKey) {
                    requestHeaders['DD-API-KEY'] = auth.apiKey;
                }

                if (auth?.appKey) {
                    requestHeaders['DD-APPLICATION-KEY'] = auth.appKey;
                }
            }

            if (typeof getData === 'function') {
                const { data, headers } = await getData();
                requestInit.body = data;
                requestHeaders = { ...requestHeaders, ...headers };
            }

            response = await fetch(url, { ...requestInit, headers: requestHeaders });
        } catch (error: any) {
            // We don't want to retry if there is a non-fetch related error.
            bail(error);
            // bail(error) throws so the return is never executed.
            return {} as T;
        }

        if (!response.ok) {
            // Not instantiating the error here, as it will make Jest throw in the tests.
            let errorMessage = `HTTP ${response.status} ${response.statusText}`;
            try {
                const bodyText = await response.text();
                const details = parseErrorDetails(bodyText);
                if (details) {
                    errorMessage += `\n${details}`;
                }
            } catch {
                // Ignore if body cannot be read.
            }
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
    }, retryOpts);
};
