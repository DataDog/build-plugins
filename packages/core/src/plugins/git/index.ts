// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { UnpluginOptions } from 'unplugin';

import type { GlobalContext, Options } from '../../types';

import { getRepositoryData, newSimpleGit } from './helpers';

export const getGitPlugin = (options: Options, context: GlobalContext): UnpluginOptions => {
    return {
        name: 'git-plugin',
        enforce: 'pre',
        async buildStart() {
            // Verify that we should get the git information based on the options.
            // Only get git information if sourcemaps are enabled and git is not disabled.
            const shouldGetGitInfo = options.rum?.sourcemaps && options.disableGit !== true;

            if (!shouldGetGitInfo) {
                return;
            }
            // Add git information to the context.
            const repositoryData = await getRepositoryData(await newSimpleGit(context.cwd));
            context.git = repositoryData;
        },
    };
};
