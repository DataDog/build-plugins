// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetInternalPlugins, GetPluginsArg } from '@dd/core/types';

import { PLUGIN_NAME } from './constants';

export { PLUGIN_NAME };

export const getAsyncQueuePlugins: GetInternalPlugins = (arg: GetPluginsArg) => {
    const { context } = arg;
    const log = context.getLogger(PLUGIN_NAME);
    const promises: Promise<any>[] = [];
    const errors: string[] = [];

    // Initialize the queue function
    context.queue = (promise: Promise<any>) => {
        // Wrap the promise to catch errors immediately
        const wrappedPromise = promise.catch((error: any) => {
            errors.push(error.message || error.toString());
        });
        promises.push(wrappedPromise);
    };

    return [
        {
            name: PLUGIN_NAME,
            asyncTrueEnd: async () => {
                // Await for all promises to finish processing.
                await Promise.all(promises);

                if (errors.length > 0) {
                    log.error(
                        `Error occurred while processing async queue:\n  ${errors.join('\n  ')}`,
                    );
                }
            },
        },
    ];
};
