// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { SITES } from '@dd/core/constants';
import { getDDEnvValue } from '@dd/core/helpers/env';
import type {
    AuthOptionsWithDefaults,
    BuildMetadata,
    Options,
    OptionsWithDefaults,
    Sites,
} from '@dd/core/types';

const SITES_DOC_URL = 'https://docs.datadoghq.com/getting_started/site/';

const isSite = (value: string): value is Sites => (SITES as readonly string[]).includes(value);

const validateAuth = (authSite: string | undefined, envSite: string | undefined): string[] => {
    const errors: string[] = [];
    if (authSite !== undefined && !isSite(authSite)) {
        errors.push(
            `auth.site "${authSite}" is not a supported Datadog site. See the site parameters in ${SITES_DOC_URL}.`,
        );
    }
    if (envSite !== undefined && !isSite(envSite)) {
        errors.push(
            `DATADOG_SITE/DD_SITE "${envSite}" is not a supported Datadog site. See the site parameters in ${SITES_DOC_URL}.`,
        );
    }
    return errors;
};

const validateMetadata = (metadata: BuildMetadata | undefined): string[] => {
    const errors: string[] = [];
    if (metadata === undefined) {
        return errors;
    }
    // TODO(next-major): also reject non-string `metadata.name`. Skipped today
    // because `metadata.name` has historically been unvalidated (and the root
    // README documents its default as `null`), so adding a type-check here
    // would be a breaking change for users who took the docs literally.
    if (metadata.version !== undefined && typeof metadata.version !== 'string') {
        errors.push('metadata.version must be a string');
    }
    return errors;
};

export const validateOptions = (options: Options = {}): OptionsWithDefaults => {
    const envSite = getDDEnvValue('SITE');
    const errors: string[] = [
        ...validateMetadata(options.metadata),
        ...validateAuth(options.auth?.site, envSite),
    ];

    if (errors.length) {
        throw new Error(`Invalid Datadog plugin configuration:\n  - ${errors.join('\n  - ')}`);
    }

    // DATADOG_SITE env var takes precedence over configuration.
    // envSite is re-checked with isSite so TS narrows it from string to Sites.
    const validatedEnvSite = envSite !== undefined && isSite(envSite) ? envSite : undefined;
    const auth: AuthOptionsWithDefaults = {
        site: validatedEnvSite ?? options.auth?.site ?? 'datadoghq.com',
    };

    // Prevent these from being accidentally logged.
    Object.defineProperty(auth, 'apiKey', {
        value: getDDEnvValue('API_KEY') || options.auth?.apiKey,
        enumerable: false,
    });

    Object.defineProperty(auth, 'appKey', {
        value: getDDEnvValue('APP_KEY') || options.auth?.appKey,
        enumerable: false,
    });

    return {
        enableGit: true,
        logLevel: 'warn',
        metadata: {},
        ...options,
        auth,
    };
};
