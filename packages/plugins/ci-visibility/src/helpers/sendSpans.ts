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

// Exported for testing.
export const parseTags = (spanTags: SpanTags, tags: LogTags): SpanTags => {
    const parsedTags: SpanTags = {};
    const allTagsWithUniqueValues: Record<string, Set<string>> = {};

    // Add the default tags to the temporary tags Sets.
    for (const [key, value] of Object.entries(spanTags)) {
        if (value) {
            allTagsWithUniqueValues[key] = new Set(value.split(/ *, */g));
        }
    }

    // Get all the tags and their (unique) values.
    for (const tag of tags) {
        const [key, ...rest] = tag.split(/ *: */g);
        const prefixedKey = key.startsWith(BUILD_PLUGIN_SPAN_PREFIX)
            ? key
            : `${BUILD_PLUGIN_SPAN_PREFIX}.${key}`;
        const value = rest.join(':');

        // If the value is already in the set, skip it.
        if (allTagsWithUniqueValues[prefixedKey]?.has(value)) {
            continue;
        }

        // If the key doesn't exist, create a new set.
        if (!allTagsWithUniqueValues[prefixedKey]) {
            allTagsWithUniqueValues[prefixedKey] = new Set();
        }

        allTagsWithUniqueValues[prefixedKey].add(value);
    }

    // Convert the sets into SpanTags.
    for (const [key, value] of Object.entries(allTagsWithUniqueValues)) {
        const stringValue = Array.from(value).join(',');
        if (!stringValue) {
            continue;
        }

        parsedTags[key as SpanTag] = stringValue;
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

    log.debug(`Submitting ${green(payloads.length.toString())} spans.`);
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
