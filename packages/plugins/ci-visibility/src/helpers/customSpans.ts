// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { capitalize } from '@dd/core/helpers/strings';
import type { GlobalContext } from '@dd/core/types';
import crypto from 'crypto';

import type { CustomSpan } from '../types';

type SimpleSpan = Omit<
    CustomSpan,
    'ci_provider' | 'span_id' | 'error_message' | 'exit_code' | 'measures'
>;

const MIN_SPAN_DURATION_IN_MS = 10;

export const getBuildName = (context: GlobalContext): string => {
    return context.build.metadata?.name ? `"${context.build.metadata.name}"` : '"unknown build"';
};

export const getCustomSpan = (provider: string, overrides: SimpleSpan): CustomSpan => ({
    ci_provider: provider,
    span_id: crypto.randomBytes(5).toString('hex'),
    error_message: '',
    exit_code: 0,
    measures: {},
    ...overrides,
});

export const getCustomSpans = (provider: string, context: GlobalContext): CustomSpan[] => {
    const startTime = context.build.start ?? Date.now();
    const endTime = context.build.end ?? Date.now();

    const command = process.argv
        .map((arg) => {
            // Clean out the path from CWD and $HOME.
            return arg.replace(process.cwd(), '').replace(process.env.HOME || '', '');
        })
        .join(' ');

    const buildName = getBuildName(context);

    const name = `Build of ${buildName} with ${capitalize(context.bundler.fullName)}`;

    const spans: SimpleSpan[] = [
        // Initial span for the full build.
        {
            command,
            name,
            start_time: new Date(startTime).toISOString(),
            end_time: new Date(endTime).toISOString(),
            tags: [`buildName:${buildName}`],
        },
    ];

    // Add all the spans from the time loggers.
    for (const timing of context.build.timings) {
        for (const span of timing.spans) {
            const end = span.end || Date.now();
            const spanDuration = end - span.start;

            if (spanDuration < MIN_SPAN_DURATION_IN_MS) {
                continue;
            }

            spans.push({
                command: `${capitalize(timing.pluginName)} | ${capitalize(timing.label)}`,
                name: `${capitalize(timing.label)}`,
                start_time: new Date(span.start).toISOString(),
                end_time: new Date(end).toISOString(),
                tags: [...timing.tags, ...span.tags],
            });
        }
    }

    return spans.map((span) => getCustomSpan(provider, span));
};
