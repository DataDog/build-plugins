// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest, NB_RETRIES } from '@dd/core/helpers/request';
import type { AuthOptions, Logger, LogTags } from '@dd/core/types';
import chalk from 'chalk';
import PQueue from 'p-queue';

import { INTAKE_PATH, INTAKE_HOST, BUILD_PLUGIN_SPAN_PREFIX } from '../constants';
import type { CustomSpan, CustomSpanPayload, SpanTag, SpanTags } from '../types';

const green = chalk.green.bold;
const yellow = chalk.yellow.bold;

const parseTags = (spanTags: SpanTags, tags: LogTags): SpanTags => {
    const parsedTags: SpanTags = {
        ...spanTags,
    };

    // Parse the log tags to format them as SpanTags.
    for (const tag of tags) {
        const [key, ...rest] = tag.split(/ ?: ?/g);
        const prefixedKey = (
            key.startsWith(BUILD_PLUGIN_SPAN_PREFIX) ? key : `${BUILD_PLUGIN_SPAN_PREFIX}.${key}`
        ) as SpanTag;
        const value = rest.map((item) => item.trim()).join(':');
        parsedTags[prefixedKey] = parsedTags[prefixedKey]
            ? `${parsedTags[prefixedKey]},${value}`
            : value;
    }

    return parsedTags;
};

export const sendSpans = async (
    auth: AuthOptions,
    payloads: CustomSpan[],
    spanTags: SpanTags,
    log: Logger,
) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!auth.apiKey) {
        errors.push('No authentication token provided.');
        return { errors, warnings };
    }

    if (payloads.length === 0) {
        warnings.push('No spans to submit.');
        return { errors, warnings };
    }

    // @ts-expect-error PQueue's default isn't typed.
    const Queue = PQueue.default ? PQueue.default : PQueue;
    const queue = new Queue({ concurrency: 20 });
    const addPromises = [];

    for (const span of payloads) {
        log.debug(`Queuing span ${green(span.name)}.`);
        const spanToSubmit: CustomSpanPayload = {
            ...span,
            tags: parseTags(spanTags, span.tags),
        };

        addPromises.push(
            queue.add(async () => {
                try {
                    await doRequest({
                        url: `https://${INTAKE_HOST}/${INTAKE_PATH}`,
                        auth: { apiKey: auth.apiKey },
                        method: 'POST',
                        getData: () => {
                            const data = {
                                data: {
                                    type: 'ci_app_custom_span',
                                    attributes: spanToSubmit,
                                },
                            };

                            return {
                                data: JSON.stringify(data),
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                            };
                        },
                        // On retry we store the error as a warning.
                        onRetry: (error: Error, attempt: number) => {
                            const warningMessage = `Failed to submit span ${yellow(span.name)}:\n  ${error.message}\nRetrying ${attempt}/${NB_RETRIES}`;
                            // This will be logged at the end of the process.
                            warnings.push(warningMessage);
                        },
                    });
                    log.debug(`Submitted span ${green(span.name)}.`);
                } catch (e: any) {
                    errors.push(`Failed to submit span ${yellow(span.name)}:\n  ${e.message}`);
                }
            }),
        );
    }

    await Promise.all(addPromises);
    await queue.onIdle();
    return { warnings, errors };
};
