// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPlugins, Options } from '@dd/core/types';

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
import { getBuildSpansPlugin } from './helpers/buildSpansPlugin';
import { getCIProvider, getCISpanTags } from './helpers/ciSpanTags';
import { getCustomSpans } from './helpers/customSpans';
import { sendSpans } from './helpers/sendSpans';
import type { CiVisibilityOptions, CiVisibilityOptionsWithDefaults, SpanTags } from './types';

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
        getBuildSpansPlugin(context, options),
        {
            name: PLUGIN_NAME,
            enforce: 'post',
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
            // NOTE: This is a bit off for esbuild because of its "trueEnd" implementation.
            async asyncTrueEnd() {
                if (!options.auth?.apiKey) {
                    log.info('No auth options, skipping.');
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

                const spansToSubmit = getCustomSpans(ci_provider, context);

                try {
                    const { errors, warnings } = await sendSpans(
                        options.auth,
                        spansToSubmit,
                        spanTags,
                        context,
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
