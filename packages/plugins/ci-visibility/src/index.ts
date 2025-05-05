// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { capitalize } from '@dd/core/helpers/strings';
import type { GetPlugins, Options } from '@dd/core/types';
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
    BUILD_PLUGIN_BUNDLER_NAME,
    BUILD_PLUGIN_BUNDLER_VERSION,
    PLUGIN_NAME,
    SUPPORTED_PROVIDERS,
} from './constants';
import { getCIProvider, getCISpanTags } from './helpers/ciSpanTags';
import { sendSpans } from './helpers/sendSpans';
import type {
    CiVisibilityOptions,
    CiVisibilityOptionsWithDefaults,
    CustomSpan,
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

    // Will populate with more tags as we get them.
    const spanTags: SpanTags = getCISpanTags();

    // Add basic tags.
    spanTags[BUILD_PLUGIN_VERSION] = context.version;
    spanTags[BUILD_PLUGIN_ENV] = context.env;

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
                // Add custom tags from the bundler report.
                spanTags[BUILD_PLUGIN_BUNDLER_NAME] = bundlerReport.name;
                spanTags[BUILD_PLUGIN_BUNDLER_VERSION] = bundlerReport.version;
            },
            async asyncTrueEnd() {
                if (!options.auth?.apiKey) {
                    log.info('No auth options, skipping');
                    return;
                }

                const ci_provider = getCIProvider();
                // Only run if we're on a supported provider.
                if (!SUPPORTED_PROVIDERS.includes(ci_provider)) {
                    log.info(
                        `"${ci_provider}" is not a supported provider, skipping spans submission`,
                    );
                    return;
                }

                const startTime = context.build.start ?? Date.now();
                const endTime = context.build.end ?? Date.now();

                const command = process.argv
                    .map((arg) => {
                        // Clean out the path from $HOME and cwd.
                        return arg.replace(process.env.HOME || '', '').replace(process.cwd(), '');
                    })
                    .join(' ');

                const buildName = context.build.metadata?.name
                    ? `"${context.build.metadata.name}"`
                    : '"unknown build"';

                const name = `Build of ${buildName} with ${capitalize(context.bundler.fullName)}`;

                const spansToSubmit: CustomSpan[] = [
                    {
                        ci_provider,
                        command,
                        name,
                        span_id: crypto.randomBytes(5).toString('hex'),
                        start_time: new Date(startTime).toISOString(),
                        end_time: new Date(endTime).toISOString(),
                        tags: [`buildName:${buildName}`],
                        error_message: '',
                        exit_code: 0,
                        measures: {},
                    },
                ];

                // Add all the spans from the time loggers.
                for (const timing of context.build.timings) {
                    for (const span of timing.spans) {
                        const end = span.end || Date.now();
                        const spanDuration = end - span.start;

                        // Skip spans that are too short.
                        if (spanDuration <= 1) {
                            continue;
                        }

                        spansToSubmit.push({
                            ci_provider,
                            command: `${timing.pluginName} | ${timing.label}`,
                            span_id: crypto.randomBytes(5).toString('hex'),
                            name: `${timing.pluginName} | ${timing.label}`,
                            start_time: new Date(span.start).toISOString(),
                            end_time: new Date(end).toISOString(),
                            tags: [...timing.tags, ...span.tags],
                            error_message: '',
                            exit_code: 0,
                            measures: {},
                        });
                    }
                }

                try {
                    const { errors, warnings } = await sendSpans(
                        options.auth,
                        spansToSubmit,
                        spanTags,
                        log,
                    );

                    if (warnings.length > 0) {
                        log.warn(
                            `Warnings while submitting spans:\n    - ${warnings.join('\n    - ')}`,
                        );
                    }

                    if (errors.length) {
                        log.warn(`Error submitting some spans:\n    - ${errors.join('\n    - ')}`);
                    }
                } catch (error) {
                    log.warn(`Error submitting spans: ${error}`);
                }
            },
        },
    ];
};
