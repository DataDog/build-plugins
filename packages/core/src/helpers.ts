// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import retry from 'async-retry';
import type { RequestInit } from 'undici-types';

import { INJECTED_FILE, INJECTION_SUFFIX } from './plugins/injection/constants';
import type { GlobalContext, RequestOpts } from './types';

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

export const getResolvedPath = (filepath: string) => {
    try {
        return require.resolve(filepath);
    } catch (e) {
        return filepath;
    }
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

// Truncate a string to a certain length.
// Placing a [...] placeholder in the middle.
// "A way too long sentence could be truncated a bit." => "A way too[...]could be truncated a bit."
export const truncateString = (
    str: string,
    maxLength: number = 60,
    placeholder: string = '[...]',
) => {
    if (str.length <= maxLength) {
        return str;
    }

    // We want to keep at the very least 4 characters.
    const stringLength = Math.max(4, maxLength - placeholder.length);

    // We want to keep most of the end of the string, hence the 10 chars top limit for left.
    const leftStop = Math.min(10, Math.floor(stringLength / 2));
    const rightStop = stringLength - leftStop;

    return `${str.slice(0, leftStop)}${placeholder}${str.slice(-rightStop)}`;
};

// Is the file coming from the injection plugin?
export const isInjectionFile = (filename: string) => filename.includes(INJECTED_FILE);
export const isInjectionProxy = (filename: string) => filename.endsWith(INJECTION_SUFFIX);
export const isFromInjection = (filename: string) =>
    isInjectionFile(filename) || isInjectionProxy(filename);

// Is the given plugin name is from our internal plugins?
export const isInternalPlugin = (pluginName: string, context: GlobalContext) => {
    for (const internalPluginName of context.pluginNames) {
        if (pluginName.includes(internalPluginName)) {
            return true;
        }
    }
    return false;
};
