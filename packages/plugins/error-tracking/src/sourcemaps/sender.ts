// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest, NB_RETRIES } from '@dd/core/helpers/request';
import { formatDuration } from '@dd/core/helpers';
import type { Logger, GlobalContext } from '@dd/core/types';
import { File } from 'buffer';
import chalk from 'chalk';
import fs from 'fs';
import PQueue from 'p-queue';
import { Readable } from 'stream';
import type { Gzip } from 'zlib';
import { createGzip } from 'zlib';

import type { SourcemapsOptionsWithDefaults, Sourcemap } from '../types';

import type { LocalAppendOptions, Metadata, MultipartFileValue, Payload } from './payload';
import { getPayload } from './payload';

type DataResponse = { data: Gzip; headers: Record<string, string> };

const green = chalk.green.bold;
const yellow = chalk.yellow.bold;
const red = chalk.red.bold;

type FileMetadata = {
    sourcemap: string;
    file: string;
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
    options: SourcemapsOptionsWithDefaults,
    context: GlobalContext,
    log: Logger,
) => {
    const errors: { metadata?: FileMetadata; error: Error }[] = [];
    const warnings: string[] = [];

    if (!context.auth?.apiKey) {
        errors.push({ error: new Error('No authentication token provided') });
        return { errors, warnings };
    }

    if (payloads.length === 0) {
        warnings.push('No sourcemaps to upload');
        return { errors, warnings };
    }

    // @ts-expect-error PQueue's default isn't typed.
    const Queue = PQueue.default ? PQueue.default : PQueue;
    const queue = new Queue({ concurrency: options.maxConcurrency });
    const defaultHeaders = {
        'DD-API-KEY': context.auth.apiKey,
        'DD-EVP-ORIGIN': `${context.bundler.fullName}-build-plugin_sourcemaps`,
        'DD-EVP-ORIGIN-VERSION': context.version,
    };

    const addPromises = [];

    for (const payload of payloads) {
        const metadata = {
            sourcemap: (payload.content.get('source_map') as MultipartFileValue)?.path.replace(
                context.bundler.outDir,
                '.',
            ),
            file: (payload.content.get('minified_file') as MultipartFileValue)?.path.replace(
                context.bundler.outDir,
                '.',
            ),
        };

        log.debug(`Queuing ${green(metadata.sourcemap)} | ${green(metadata.file)}`);

        addPromises.push(
            queue.add(async () => {
                try {
                    await doRequest({
                        url: options.intakeUrl,
                        method: 'POST',
                        getData: getData(payload, defaultHeaders),
                        // On retry we store the error as a warning.
                        onRetry: (error: Error, attempt: number) => {
                            const warningMessage = `Failed to upload ${yellow(metadata.sourcemap)} | ${yellow(metadata.file)}:\n  ${error.message}\nRetrying ${attempt}/${NB_RETRIES}`;
                            // This will be logged at the end of the process.
                            warnings.push(warningMessage);
                            log.debug(warningMessage);
                        },
                    });
                    log.debug(`Sent ${green(metadata.sourcemap)} | ${green(metadata.file)}`);
                } catch (e: any) {
                    errors.push({ metadata, error: e });
                    // Depending on the configuration we throw or not.
                    if (options.bailOnError === true) {
                        throw e;
                    }
                }
            }),
        );
    }

    await Promise.all(addPromises);
    await queue.onIdle();
    return { warnings, errors };
};

export const sendSourcemaps = async (
    sourcemaps: Sourcemap[],
    options: SourcemapsOptionsWithDefaults,
    context: GlobalContext,
    log: Logger,
) => {
    const start = Date.now();
    const prefix = options.minifiedPathPrefix;

    const metadata: Metadata = {
        git_repository_url: context.git?.remote,
        git_commit_sha: context.git?.hash,
        plugin_version: context.version,
        project_path: context.bundler.outDir,
        service: options.service,
        type: 'js_sourcemap',
        version: options.releaseVersion,
    };

    const payloads = await Promise.all(
        sourcemaps.map((sourcemap) => getPayload(sourcemap, metadata, prefix, context.git)),
    );

    const errors = payloads.map((payload) => payload.errors).flat();
    const warnings = payloads.map((payload) => payload.warnings).flat();

    if (warnings.length > 0) {
        log.warn(`Warnings while preparing payloads:\n    - ${warnings.join('\n    - ')}`);
    }

    if (errors.length > 0) {
        const errorMsg = `Failed to prepare payloads, aborting upload :\n    - ${errors.join('\n    - ')}`;
        log.error(errorMsg);
        // Depending on the configuration we throw or not.
        if (options.bailOnError === true) {
            throw new Error(errorMsg);
        }
        return;
    }

    const { errors: uploadErrors, warnings: uploadWarnings } = await upload(
        payloads,
        options,
        context,
        log,
    );

    log.info(
        `Done uploading ${green(sourcemaps.length.toString())} sourcemaps in ${green(formatDuration(Date.now() - start))}.`,
    );

    if (uploadErrors.length > 0) {
        const listOfErrors = `    - ${uploadErrors
            .map(({ metadata: fileMetadata, error }) => {
                if (fileMetadata) {
                    return `${red(fileMetadata.file)} | ${red(fileMetadata.sourcemap)} : ${error.message}`;
                }
                return error.message;
            })
            .join('\n    - ')}`;

        const errorMsg = `Failed to upload some sourcemaps:\n${listOfErrors}`;
        log.error(errorMsg);
        // Depending on the configuration we throw or not.
        // This should not be reached as we'd have thrown earlier.
        if (options.bailOnError === true) {
            throw new Error(errorMsg);
        }
    }

    if (uploadWarnings.length > 0) {
        log.warn(`Warnings while uploading sourcemaps:\n    - ${uploadWarnings.join('\n    - ')}`);
    }
};
