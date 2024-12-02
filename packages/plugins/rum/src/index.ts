// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest } from '@dd/core/helpers';
import type { GlobalContext, GetPlugins, Logger } from '@dd/core/types';

import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import type { OptionsWithRum, RumOptions } from './types';
import { validateOptions } from './validate';

export { CONFIG_KEY, PLUGIN_NAME };

export const helpers = {
    // Add the helpers you'd like to expose here.
};

export type types = {
    // Add the types you'd like to expose here.
    RumOptions: RumOptions;
    OptionsWithRum: OptionsWithRum;
};

type RumAppResponse = {
    data: {
        attributes: {
            client_token: string;
        };
    };
};

export const getPlugins: GetPlugins<OptionsWithRum> = (
    opts: OptionsWithRum,
    context: GlobalContext,
    log: Logger,
) => {
    // Verify configuration.
    const options = validateOptions(opts, log);

    context.inject({
        type: 'file',
        value: 'https://www.datadoghq-browser-agent.com/us1/v5/datadog-rum.js',
    });

    return [
        {
            name: PLUGIN_NAME,
            // Enforce when the plugin will be executed.
            // Not supported by Rollup and ESBuild.
            // https://vitejs.dev/guide/api-plugin.html#plugin-ordering
            enforce: 'pre',
            async buildStart() {
                if (!options.sdk) {
                    return;
                }

                if (!options.sdk.clientToken) {
                    if (!context.auth?.apiKey || !context.auth?.appKey) {
                        throw new Error(
                            'Missing auth.apiKey and/or auth.appKey to fetch clientToken.',
                        );
                    }

                    const sdkOpts = options.sdk;
                    let clientToken: string;

                    try {
                        // Fetch the client token from the API.
                        const appResponse = await doRequest<RumAppResponse>({
                            url: `https://api.datadoghq.com/api/v2/rum/applications/${options.sdk.applicationId}`,
                            type: 'json',
                            auth: context.auth,
                        });

                        clientToken = appResponse.data?.attributes?.client_token;
                    } catch (e: any) {
                        // Could not fetch the clientToken.
                        // Let's crash the build.
                        throw new Error(`Could not fetch the clientToken: ${e.message}`);
                    }

                    // Still no clientToken.
                    if (!clientToken) {
                        throw new Error('Missing clientToken in the API response.');
                    }

                    console.log('INJECTING');
                    // Inject the initialization code.
                    context.inject({
                        type: 'code',
                        value: `DD_RUM.init(${JSON.stringify({
                            clientToken,
                            ...sdkOpts,
                        })});`,
                    });
                }
            },
        },
    ];
};
