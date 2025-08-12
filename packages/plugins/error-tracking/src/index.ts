// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { shouldGetGitInfo } from '@dd/core/helpers/plugins';
import type { BuildReport, GetPlugins, RepositoryData } from '@dd/core/types';

import { PLUGIN_NAME } from './constants';
import { uploadSourcemaps } from './sourcemaps';
import type { ErrorTrackingOptions, ErrorTrackingOptionsWithSourcemaps } from './types';
import { validateOptions } from './validate';

export { CONFIG_KEY, PLUGIN_NAME } from './constants';

export type types = {
    // Add the types you'd like to expose here.
    ErrorTrackingOptions: ErrorTrackingOptions;
};

export const getPlugins: GetPlugins = ({ options, context }) => {
    const log = context.getLogger(PLUGIN_NAME);
    // Verify configuration.
    const timeOptions = log.time('validate options');
    const validatedOptions = validateOptions(options, log);
    timeOptions.end();

    // If the plugin is not enabled, return an empty array.
    if (!validatedOptions.enable) {
        return [];
    }

    let gitInfo: RepositoryData | undefined;
    let buildReport: BuildReport | undefined;

    const handleSourcemaps = async () => {
        if (!validatedOptions.sourcemaps) {
            return;
        }
        const totalTime = log.time('sourcemaps process');
        await uploadSourcemaps(
            // Need the "as" because Typescript doesn't understand that we've already checked for sourcemaps.
            validatedOptions as ErrorTrackingOptionsWithSourcemaps,
            {
                apiKey: context.auth.apiKey,
                bundlerName: context.bundler.name,
                git: gitInfo,
                outDir: context.bundler.outDir,
                outputs: buildReport?.outputs || [],
                site: context.auth.site,
                version: context.version,
            },
            log,
        );
        totalTime.end();
    };

    return [
        {
            name: PLUGIN_NAME,
            enforce: 'post',
            async git(repoData) {
                gitInfo = repoData;

                if (buildReport) {
                    await handleSourcemaps();
                }
            },
            async buildReport(report) {
                buildReport = report;

                if (gitInfo || !shouldGetGitInfo(options)) {
                    await handleSourcemaps();
                }
            },
        },
    ];
};
