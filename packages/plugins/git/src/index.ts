// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetInternalPlugins, GlobalContext, Options } from '@dd/core/types';

import { getRepositoryData, newSimpleGit } from './helpers';

export const PLUGIN_NAME = 'datadog-git-plugin';

export const getGitPlugins: GetInternalPlugins = (options: Options, context: GlobalContext) => {
    const log = context.getLogger(PLUGIN_NAME);
    return [
        {
            name: PLUGIN_NAME,
            enforce: 'pre',
            async buildStart() {
                // Verify that we should get the git information based on the options.
                // Only get git information if sourcemaps are enabled and git is not disabled.
                const shouldGetGitInfo =
                    options.errorTracking?.sourcemaps &&
                    options.errorTracking?.sourcemaps.disableGit !== true &&
                    options.disableGit !== true;

                if (!shouldGetGitInfo) {
                    return;
                }

                try {
                    const timeGit = log.time('get git information');
                    // Add git information to the context.
                    const repositoryData = await getRepositoryData(await newSimpleGit(context.cwd));
                    context.git = repositoryData;

                    timeGit.end();
                    await context.asyncHook('git', context.git);
                } catch (e: any) {
                    // We don't want to have the build fail for this.
                    log.error(`Could not get git information: ${e.message}`);
                }
            },
        },
    ];
};
