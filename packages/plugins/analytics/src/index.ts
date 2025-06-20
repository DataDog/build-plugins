// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { submitLog } from '@dd/core/helpers/log';
import type { GetInternalPlugins, GetPluginsArg } from '@dd/core/types';

import { PLUGIN_NAME } from './constants';

export { PLUGIN_NAME } from './constants';

export const getAnalyticsPlugins: GetInternalPlugins = (arg: GetPluginsArg) => {
    const { context } = arg;
    const log = arg.context.getLogger(PLUGIN_NAME);

    context.sendLog = async (message: string, overrides: Record<string, string> = {}) => {
        // Only send logs in production.
        if (context.env !== 'production') {
            return;
        }

        try {
            await submitLog({ context, message, rest: overrides });
        } catch (e: unknown) {
            // We don't want to break anything in case of error.
            log.debug(`Could not submit data to Datadog: ${e}`);
        }
    };

    return [
        {
            name: PLUGIN_NAME,
            async buildStart() {
                // Send a log.
                await context.sendLog('Build started');
            },
        },
    ];
};
