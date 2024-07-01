// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/log';
import type { GlobalContext } from '@dd/core/types';
import retry from 'async-retry';
import { File } from 'buffer';
import chalk from 'chalk';
import fs from 'fs';
import PQueue from 'p-queue';
import { Readable } from 'stream';
import type { Gzip } from 'zlib';
import { createGzip } from 'zlib';

import type { RumSourcemapsOptionsWithDefaults, Sourcemap } from '../types';

import type { LocalAppendOptions, Metadata, MultipartFileValue, Payload } from './payload';
import { getPayload } from './payload';

const errorCodesNoRetry = [400, 403, 413];
const nbRetries = 5;

type DataResponse = { data: Gzip; headers: Record<string, string> };

const green = chalk.green.bold;

export const doRequest = async (
    url: string,
    // Need a function to get new streams for each retry.
    getData: () => Promise<DataResponse> | DataResponse,
    onRetry?: (error: Error, attempt: number) => void,
) => {
    return retry(
        async (bail: (e: Error) => void, attempt: number) => {
            let response: Response;
            try {
                const { data, headers } = await getData();

                response = await fetch(url, {
                    method: 'POST',
                    body: data,
                    headers,
                    // This is needed for sending body in NodeJS' Fetch.
                    // https://github.com/nodejs/node/issues/46221
                    duplex: 'half',
                });
            } catch (error: any) {
                // We don't want to retry if there is a non-fetch related error.
                bail(new Error(error));
                return;
            }

            if (!response.ok) {
                // Not instantiating the error here, as it will make Jest throw in the tests.
                const error = `HTTP ${response.status} ${response.statusText}`;
                if (errorCodesNoRetry.includes(response.status)) {
                    bail(new Error(error));
                    return;
                } else {
                    // Trigger the retry.
                    throw new Error(error);
                }
            }

            try {
                // Await it so we catch any parsing error and bail.
                const result = await response.json();
                return result;
            } catch (error: any) {
                // We don't want to retry on parsing errors.
                bail(new Error(error));
            }
        },
        {
            retries: nbRetries,
            onRetry,
        },
    );
};

// From a path, returns a File to use with native FormData and fetch.
const getFile = async (path: string, options: LocalAppendOptions) => {
    // @ts-expect-error openAsBlob is not in the NodeJS types until 19+
    if (typeof fs.openAsBlob === 'function') {
        // Support NodeJS 19+
        // @ts-expect-error openAsBlob is not in the NodeJS types until 19+
        const blob = await fs.openAsBlob(path, { type: options.contentType });
        return new File([blob], options.filename);
    } else {
        // Support NodeJS 18-
        const stream = Readable.toWeb(fs.createReadStream(path));
        const blob = await new Response(stream).blob();
        const file = new File([blob], options.filename, { type: options.contentType });
        return file;
    }
};

// Use a function to get new streams for each retry.
export const getData =
    (payload: Payload, defaultHeaders: Record<string, string> = {}) =>
    async (): Promise<DataResponse> => {
        const form = new FormData();
        const gz = createGzip();

        for (const [key, content] of payload.content) {
            const value =
                content.type === 'file'
                    ? // eslint-disable-next-line no-await-in-loop
                      await getFile(content.path, content.options)
                    : new Blob([content.value], { type: content.options.contentType });

            form.append(key, value, content.options.filename);
        }

        // GZip data, we use a Request to serialize the data and transform it into a stream.
        const req = new Request('fake://url', { method: 'POST', body: form });
        const formStream = Readable.fromWeb(req.body!);
        const data = formStream.pipe(gz);

        const headers = {
            'Content-Encoding': 'gzip',
            ...defaultHeaders,
            ...Object.fromEntries(req.headers.entries()),
        };

        return { data, headers };
    };

export const upload = async (
    payloads: Payload[],
    options: RumSourcemapsOptionsWithDefaults,
    context: GlobalContext,
    log: Logger,
) => {
    if (!context.auth?.apiKey) {
        throw new Error('No authentication token provided');
    }

    if (payloads.length === 0) {
        log('No sourcemaps to upload', 'warn');
        return;
    }

    const queue = new PQueue({ concurrency: options.maxConcurrency });
    const defaultHeaders = {
        'DD-API-KEY': context.auth.apiKey,
        'DD-EVP-ORIGIN': `${context.bundler.name}-build-plugin_sourcemaps`,
        'DD-EVP-ORIGIN-VERSION': context.version,
    };

    for (const payload of payloads) {
        const metadata = {
            sourcemap: (payload.content.get('source_map') as MultipartFileValue)?.path,
            file: (payload.content.get('minified_file') as MultipartFileValue)?.path,
        };

        log(`Queuing ${green(metadata.sourcemap)} | ${green(metadata.file)}`);

        // eslint-disable-next-line no-await-in-loop
        queue.add(async () => {
            await doRequest(
                options.intakeUrl,
                getData(payload, defaultHeaders),
                (error: Error, attempt: number) => {
                    log(
                        `Failed to upload sourcemaps: ${error.message}\nRetrying ${attempt}/${nbRetries}`,
                        'warn',
                    );
                },
            );
            log(`Sent ${green(metadata.sourcemap)} | ${green(metadata.file)}`);
        });
    }

    return queue.onIdle();
};

export const sendSourcemaps = async (
    sourcemaps: Sourcemap[],
    options: RumSourcemapsOptionsWithDefaults,
    context: GlobalContext,
    log: Logger,
) => {
    const prefix = options.minifiedPathPrefix;

    const metadata: Metadata = {
        git_repository_url: context.git?.remote,
        git_commit_sha: context.git?.hash,
        plugin_version: context.version,
        project_path: options.basePath,
        service: options.service,
        type: 'js_sourcemap',
        version: options.releaseVersion,
    };

    const payloads = await Promise.all(
        sourcemaps.map((sourcemap) => getPayload(sourcemap, metadata, prefix, context.git)),
    );

    const errors = payloads.map((payload) => payload.errors).flat();
    const warnings = payloads.map((payload) => payload.warnings).flat();

    if (errors.length > 0) {
        const errorMsg = `Failed to upload sourcemaps:\n    - ${errors.join('\n    - ')}`;
        log(errorMsg, 'error');
        throw new Error(errorMsg);
    }

    if (warnings.length > 0) {
        log(`Warnings while uploading sourcemaps:\n    - ${warnings.join('\n    - ')}`, 'warn');
    }

    try {
        await upload(payloads, options, context, log);
    } catch (error: any) {
        log(`Failed to upload sourcemaps: ${error.message}`, 'error');
        throw error;
    }
};
