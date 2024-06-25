// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/log';
import type { GlobalContext } from '@dd/core/types';
import retry from 'async-retry';
import FormData from 'form-data';
import fs from 'fs';
import PQueue from 'p-queue';
import type { Gzip } from 'zlib';
import { createGzip } from 'zlib';

import type { RumSourcemapsOptionsWithDefaults, Sourcemap } from '../types';

import type { Metadata, Payload } from './payload';
import { getPayload } from './payload';

const errorCodesNoRetry = [400, 403, 413];
const nbRetries = 5;

export const doRequest = async (
    url: string,
    data: Gzip,
    headers: Record<string, string>,
    onRetry?: (error: Error, attempt: number) => void,
) => {
    return retry(
        async (bail: (e: Error) => void, attempt: number) => {
            let response: Response;
            try {
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
                bail(error);
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
                bail(error);
            }
        },
        {
            retries: nbRetries,
            onRetry,
        },
    );
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
    const gz = createGzip();
    const defaultHeaders = {
        'DD-API-KEY': context.auth.apiKey,
        'DD-EVP-ORIGIN': `${context.bundler.name}-build-plugin_sourcemaps`,
        'DD-EVP-ORIGIN-VERSION': context.version,
    };

    for (const payload of payloads) {
        // Using form-data as a dependency isn't really required.
        // But this implementation makes it mandatory for the gzip step.
        // NodeJS' fetch SHOULD support everything else from the native FormData primitive.
        // content.options are totally optional and should only be filename.
        // form.getHeaders() is natively handled by fetch and FormData.
        // TODO: Remove form-data dependency.
        const form = new FormData();

        for (const [key, content] of payload.content) {
            const value =
                content.type === 'file' ? fs.createReadStream(content.path) : content.value;

            form.append(key, value, content.options);
        }

        // GZip data.
        const data = form.pipe(gz);
        const headers = {
            'Content-Encoding': 'gzip',
            ...defaultHeaders,
            ...form.getHeaders(),
        };

        // eslint-disable-next-line no-await-in-loop
        queue.add(async () => {
            await doRequest(options.intakeUrl, data, headers, (error: Error, attempt: number) => {
                log(
                    `Failed to upload sourcemaps: ${error.message}\nRetrying ${attempt}/${nbRetries}`,
                    'warn',
                );
            });
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