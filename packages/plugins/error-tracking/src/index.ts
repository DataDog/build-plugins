// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { resolveEnable } from '@dd/core/helpers/options';
import { shouldGetGitInfo } from '@dd/core/helpers/plugins';
import type { BuildReport, GetPlugins, RepositoryData } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';

import { PLUGIN_NAME } from './constants';
import { getDebugIdSnippet } from './debugId';
import { uploadSourcemaps } from './sourcemaps';
import type { ErrorTrackingOptions, ErrorTrackingOptionsWithSourcemaps } from './types';
import { validateOptions } from './validate';

export { CONFIG_KEY, PLUGIN_NAME } from './constants';

export type types = {
    ErrorTrackingOptions: ErrorTrackingOptions;
};

export const getPlugins: GetPlugins = ({ bundler, options, context }) => {
    const log = context.getLogger(PLUGIN_NAME);
    const timeOptions = log.time('validate options');
    const validatedOptions = validateOptions(options, log);
    timeOptions.end();
    const sendSourcemapUploadMetrics = resolveEnable(options, 'metrics', log);

    let gitInfo: RepositoryData | undefined;
    let buildReport: BuildReport | undefined;
    let sourcemapsHandled: boolean = false;

    const handleSourcemaps = async () => {
        if (!validatedOptions.sourcemaps || sourcemapsHandled) {
            return;
        }
        sourcemapsHandled = true;
        const totalTime = log.time('sourcemaps process');
        await uploadSourcemaps(
            // Need the "as" because Typescript doesn't understand that we've already checked for sourcemaps.
            validatedOptions as ErrorTrackingOptionsWithSourcemaps,
            {
                apiKey: context.auth.apiKey,
                bundlerName: context.bundler.name,
                git: gitInfo,
                addMetric: context.addMetric,
                outDir: context.bundler.outDir,
                outputs: buildReport?.outputs || [],
                sendMetrics: sendSourcemapUploadMetrics,
                site: context.auth.site,
                version: context.version,
            },
            log,
        );
        totalTime.end();
    };

    const plugins: ReturnType<GetPlugins> = [
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
            async asyncTrueEnd() {
                // If we're at the end and sourcemaps have not been handled yet,
                // just do it. It can happen when git data isn't accessible for some reason.
                // For insteance, when working from an unpushed repository.
                if (!sourcemapsHandled) {
                    await handleSourcemaps();
                }
            },
        },
    ];

    if (validatedOptions.debugId) {
        context.inject({
            type: 'code',
            position: InjectPosition.BEFORE,
            allChunks: true,
            value: (sourceOrHash) => getDebugIdSnippet(sourceOrHash),
        });
    }

    return plugins;
};
