// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getClosest } from '@dd/core/helpers/paths';
import { shouldGetGitInfo } from '@dd/core/helpers/plugins';
import type { GetInternalPlugins, GetPluginsArg } from '@dd/core/types';
import path from 'path';

import { getRepositoryData, newSimpleGit } from './helpers';

export const PLUGIN_NAME = 'datadog-git-plugin';

export const getGitPlugins: GetInternalPlugins = (arg: GetPluginsArg) => {
    const { options, context } = arg;
    const log = context.getLogger(PLUGIN_NAME);
    const timeGit = log.time('get git information', { start: false });
    const processGit = async (gitDir: string) => {
        try {
            const repositoryData = await getRepositoryData(
                await newSimpleGit(path.dirname(gitDir!)),
            );
            context.git = repositoryData;

            timeGit.end();
            await context.asyncHook('git', context.git);
        } catch (e: any) {
            log.error(`Could not get git information: ${e.message}`);
        }
    };

    return [
        {
            name: PLUGIN_NAME,
            enforce: 'pre',
            buildRoot(buildRoot) {
                if (!shouldGetGitInfo(options)) {
                    return;
                }

                try {
                    timeGit.resume();
                    // Add git information to the context.
                    const gitDir = getClosest(buildRoot, '.git');
                    if (!gitDir) {
                        log.warn('No .git directory found, skipping git plugin.');
                        return;
                    }

                    // buildRoot hook is sync because xpack can't make it async.
                    // So we queue the async part of the plugin.
                    context.queue(processGit(gitDir));
                } catch (e: any) {
                    // We don't want to have the build fail for this.
                    log.error(`Could not get git information: ${e.message}`);
                }
            },
        },
    ];
};
