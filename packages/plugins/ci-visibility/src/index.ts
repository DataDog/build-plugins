// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPlugins, Options, Timer } from '@dd/core/types';
import crypto from 'crypto';

import {
    CONFIG_KEY,
    GIT_BRANCH,
    GIT_COMMIT_AUTHOR_DATE,
    GIT_COMMIT_AUTHOR_EMAIL,
    GIT_COMMIT_AUTHOR_NAME,
    GIT_COMMIT_COMMITTER_DATE,
    GIT_COMMIT_COMMITTER_EMAIL,
    GIT_COMMIT_COMMITTER_NAME,
    GIT_COMMIT_MESSAGE,
    GIT_REPOSITORY_URL,
    GIT_SHA,
    BUILD_PLUGIN_ENV,
    BUILD_PLUGIN_VERSION,
    BUILD_BUNDLER_NAME,
    BUILD_BUNDLER_VERSION,
    PLUGIN_NAME,
} from './constants';
import { getCIProvider, getCISpanTags } from './helpers/ciSpanTags';
import { sendSpans } from './helpers/sendSpans';
import type {
    CiVisibilityOptions,
    CiVisibilityOptionsWithDefaults,
    CustomSpanPayload,
    SpanTags,
} from './types';

export { CONFIG_KEY, PLUGIN_NAME };

export const helpers = {
    // Add the helpers you'd like to expose here.
};

export type types = {
    // Add the types you'd like to expose here.
    CiVisibilityOptions: CiVisibilityOptions;
};

// Deal with validation and defaults here.
export const validateOptions = (options: Options): CiVisibilityOptionsWithDefaults => {
    // TODO: If we're missing API Key, we can't submit.

    const validatedOptions: CiVisibilityOptionsWithDefaults = {
        disabled: !options[CONFIG_KEY],
        ...options[CONFIG_KEY],
    };

    return validatedOptions;
};

export const getPlugins: GetPlugins = ({ options, context }) => {
    const log = context.getLogger(PLUGIN_NAME);
    // Verify configuration.
    const validatedOptions = validateOptions(options);

    // If the plugin is disabled, return an empty array.
    if (validatedOptions.disabled) {
        return [];
    }

    // Will populate with tags as we get them.
    const spanTags: SpanTags = getCISpanTags();
    const spansToReport: Timer[] = [];

    // Add basic tags.
    spanTags[BUILD_PLUGIN_VERSION] = context.version;
    spanTags[BUILD_PLUGIN_ENV] = context.env;

    // TODO: Add custom tags from config.
    // TODO: Add measures from config.
    // TODO: Only run for supported providers.

    return [
        {
            name: PLUGIN_NAME,
            git: (gitData) => {
                // Add tags from git data.
                spanTags[GIT_REPOSITORY_URL] = gitData.remote;
                spanTags[GIT_BRANCH] = gitData.branch;
                spanTags[GIT_SHA] = gitData.commit.hash;
                spanTags[GIT_COMMIT_MESSAGE] = gitData.commit.message;
                spanTags[GIT_COMMIT_AUTHOR_NAME] = gitData.commit.author.name;
                spanTags[GIT_COMMIT_AUTHOR_EMAIL] = gitData.commit.author.email;
                spanTags[GIT_COMMIT_AUTHOR_DATE] = gitData.commit.author.date;
                spanTags[GIT_COMMIT_COMMITTER_NAME] = gitData.commit.committer.name;
                spanTags[GIT_COMMIT_COMMITTER_EMAIL] = gitData.commit.committer.email;
                spanTags[GIT_COMMIT_COMMITTER_DATE] = gitData.commit.committer.date;
            },
            bundlerReport: (bundlerReport) => {
                // Add tags from the bundler report.
                spanTags[BUILD_BUNDLER_NAME] = bundlerReport.name;
                spanTags[BUILD_BUNDLER_VERSION] = bundlerReport.version;
            },
            buildReport: (buildReport) => {
                // Get all the spans from the build report.
                spansToReport.push(
                    ...buildReport.timings.filter((timing) => timing.label.startsWith('hook |')),
                );
            },
            async writeBundle() {
                if (!options.auth) {
                    log.info('No auth options, skipping');
                    return;
                }

                const startTime = context.build.start ?? Date.now();
                const endTime = context.build.end ?? Date.now();

                const payload: CustomSpanPayload = {
                    ci_provider: getCIProvider(),
                    span_id: crypto.randomBytes(5).toString('hex'),
                    command: process.argv.join(' '),
                    name: `${context.bundler.fullName} build process`,
                    start_time: new Date(startTime).toISOString(),
                    end_time: new Date(endTime).toISOString(),
                    error_message: '',
                    exit_code: 0,
                    tags: spanTags,
                    measures: {},
                };

                console.log('PAYLOAD', payload);
                const result = await sendSpans(options.auth, payload);
                console.log('RESULT', context.bundler.fullName, result);
            },
        },
    ];
};
