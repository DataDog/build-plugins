// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetInternalPlugins } from '@dd/core/types';

import { PLUGIN_NAME } from './constants';

export { PLUGIN_NAME } from './constants';

export const getAnalyticsPlugins: GetInternalPlugins = ({ context }) => {
    const log = context.getLogger(PLUGIN_NAME);
    const buildStartFn = async () => {
        try {
            await context.sendLog({
                message: 'Build started',
                context: {
                    plugins: context.pluginNames,
                },
            });
        } catch (e: unknown) {
            // We don't want to break anything in case of error.
            log.debug(`Could not submit data to Datadog: ${e}`);
        }
    };

    return [
        {
            name: PLUGIN_NAME,
            async buildStart() {
                // Only send logs in production.
                if (context.env !== 'production') {
                    return;
                }

                // Use the queue so it doesn't block the build process.
                context.queue(buildStartFn());
            },
        },
    ];
};
