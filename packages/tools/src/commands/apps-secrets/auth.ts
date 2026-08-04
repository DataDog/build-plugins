// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { DEFAULT_SITE, SITES } from '@dd/core/constants';
import { getDDEnvValue } from '@dd/core/helpers/env';
import type { ApiKeyRequestAuthOptions, Site } from '@dd/core/types';

export const AUTH_GUIDANCE = 'Set DD_API_KEY and DD_APP_KEY (or DATADOG_API_KEY/DATADOG_APP_KEY).';

export class MissingAuthenticationError extends Error {
    constructor() {
        super(`Missing authentication. ${AUTH_GUIDANCE}`);
        this.name = 'MissingAuthenticationError';
    }
}

const isSite = (value: string): value is Site => (SITES as readonly string[]).includes(value);

// The apps-secrets CLI runs standalone, outside any bundler plugin context, so unlike
// packages/plugins/apps/src/auth.ts it only resolves API/App key auth from the
// environment — there is no OAuth flow or plugin options object to read from here.
export const resolveAuth = (): { auth: Required<ApiKeyRequestAuthOptions>; site: Site } => {
    const apiKey = getDDEnvValue('API_KEY');
    const appKey = getDDEnvValue('APP_KEY');

    if (!apiKey || !appKey) {
        throw new MissingAuthenticationError();
    }

    const siteValue = getDDEnvValue('SITE');
    const site = siteValue && isSite(siteValue) ? siteValue : DEFAULT_SITE;

    return { auth: { apiKey, appKey }, site };
};
