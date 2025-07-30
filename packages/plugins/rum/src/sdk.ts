// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest } from '@dd/core/helpers/request';
import type { GlobalContext, InjectedValue } from '@dd/core/types';

import type { RumOptionsWithDefaults, RumOptionsWithSdk } from './types';

type RumAppResponse = {
    data: {
        attributes: {
            client_token: string;
        };
    };
};

const getContent = (opts: RumOptionsWithDefaults) => {
    return `DD_RUM.init({${JSON.stringify(opts.sdk).replace(/(^{|}$)/g, '')}});
`;
};

export const getInjectionValue = (
    options: RumOptionsWithSdk,
    context: GlobalContext,
): InjectedValue => {
    const sdkOpts = options.sdk;
    // We already have the clientToken, we can inject it directly.
    if (sdkOpts.clientToken) {
        return getContent(options);
    }

    // Let's try and fetch the clientToken from the API.
    if (!context.auth.apiKey || !context.auth.appKey) {
        throw new Error(
            'Missing "auth.apiKey" and/or "auth.appKey" to fetch "rum.sdk.clientToken".',
        );
    }

    // Return the value as an async function so it gets resolved during buildStart.
    return async () => {
        let clientToken: string;
        try {
            // Fetch the client token from the API.
            const appResponse = await doRequest<RumAppResponse>({
                url: `https://api.datadoghq.com/api/v2/rum/applications/${sdkOpts.applicationId}`,
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

        return getContent({
            ...options,
            sdk: {
                clientToken,
                ...sdkOpts,
            },
        });
    };
};
