// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { AuthMethod, RequestAuthOptions } from '@dd/core/types';

// Build the request-local auth from the resolved method + base credentials.
// Returns undefined when API-key auth is selected but credentials are missing,
// which the uploader surfaces as a clear error.
export const getRequestAuth = (
    method: AuthMethod,
    auth: { apiKey?: string; appKey?: string; site: string },
): RequestAuthOptions | undefined => {
    if (method === 'oauth') {
        return { authMethod: 'oauth', site: auth.site };
    }

    if (auth.apiKey && auth.appKey) {
        return { authMethod: 'apiKey', apiKey: auth.apiKey, appKey: auth.appKey };
    }

    return undefined;
};
