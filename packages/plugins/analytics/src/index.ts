// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest } from '@dd/core/helpers/request';
import type { GlobalContext, PluginOptions } from '@dd/core/types';

import { INTAKE_HOST, INTAKE_PATH, PLUGIN_NAME } from './constants';

export { PLUGIN_NAME } from './constants';

export const getAnalyticsPlugins = (context: GlobalContext): PluginOptions[] => {
    const log = context.getLogger(PLUGIN_NAME);

    context.sendLog = async (message: string, overrides: any = {}) => {
        // Only send logs in production.
        if (context.env !== 'production') {
            return;
        }

        try {
            const bundler = {
                name: context.bundler.name,
                version: context.bundler.version,
            };

            await doRequest({
                // Don't delay the build too much on error.
                retries: 2,
                minTimeout: 100,
                url: `https://${INTAKE_HOST}/${INTAKE_PATH}`,
                method: 'POST',
                type: 'json',
                getData: async () => {
                    const data = {
                        ddsource: `@datadog/${bundler.name}-plugin`,
                        env: context.env,
                        message,
                        service: 'build-plugins',
                        bundler,
                        plugins: context.pluginNames,
                        version: context.version,
                        team: 'language-foundations',
                        ...overrides,
                    };
                    return {
                        data: JSON.stringify(data),
                        headers: {
                            'Content-Type': 'application/json',
                        },
                    };
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
                // Send a log.
                await context.sendLog('Build started');
            },
        },
    ];
};
