// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest } from '@dd/core/helpers';
import type { GlobalContext, InjectedValue } from '@dd/core/types';

import type { SDKOptionsWithDefaults } from './types';

type RumAppResponse = {
    data: {
        attributes: {
            client_token: string;
        };
    };
};

export const getInjectionValue = (
    sdkOpts: SDKOptionsWithDefaults,
    context: GlobalContext,
): InjectedValue => {
    // We already have the clientToken, we can inject it directly.
    if (sdkOpts.clientToken) {
        return `DD_RUM.init(${JSON.stringify(sdkOpts)});`;
    }

    // Let's fetch the clientToken from the API.
    if (!context.auth?.apiKey || !context.auth?.appKey) {
        throw new Error('Missing auth.apiKey and/or auth.appKey to fetch clientToken.');
    }

    let clientToken: string;

    return async () => {
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

        return `DD_RUM.init(${JSON.stringify({
            clientToken,
            ...sdkOpts,
        })});`;
    };
};
