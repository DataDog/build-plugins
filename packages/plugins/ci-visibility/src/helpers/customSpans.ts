// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { capitalize } from '@dd/core/helpers/strings';
import type { GlobalContext } from '@dd/core/types';
import crypto from 'crypto';

import type { CustomSpan } from '../types';

import { BUILD_SPANS_PLUGIN_NAME } from './buildSpansPlugin';

type SimpleSpan = Omit<
    CustomSpan,
    'ci_provider' | 'span_id' | 'error_message' | 'exit_code' | 'measures'
>;

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
    const buildName = getBuildName(context);
    const name = `Build of ${buildName} with ${capitalize(context.bundler.fullName)}`;
    const spans: SimpleSpan[] = [];

    // Add all the spans from the time loggers.
    for (const timing of context.build.timings) {
        // Only add spans that are coming from our own plugin.
        if (timing.pluginName !== BUILD_SPANS_PLUGIN_NAME) {
            continue;
        }

        for (const span of timing.spans) {
            const end = span.end || Date.now();
            spans.push({
                command: `${name} | ${capitalize(timing.label)}`,
                name: `${capitalize(timing.label)}`,
                start_time: new Date(span.start).toISOString(),
                end_time: new Date(end).toISOString(),
                tags: [`buildName:${buildName}`, ...timing.tags, ...span.tags],
            });
        }
    }

    return spans.map((span) => getCustomSpan(provider, span));
};
