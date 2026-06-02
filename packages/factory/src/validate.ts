// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { DEFAULT_SITE, SITES } from '@dd/core/constants';
import { getDDEnvValue } from '@dd/core/helpers/env';
import type {
    AuthOptionsWithDefaults,
    BuildMetadata,
    Options,
    OptionsWithDefaults,
    Site,
} from '@dd/core/types';

const SITES_DOC_URL = 'https://docs.datadoghq.com/getting_started/site/';

const isSite = (value: string): value is Site => SITES.some((s) => s === value);

const resolveSite = (
    value: string | undefined,
    source: string,
    errors: string[],
): Site | undefined => {
    if (value === undefined) {
        return undefined;
    }
    if (isSite(value)) {
        return value;
    }
    errors.push(
        `${source} "${value}" is not a supported Datadog site. See the site parameters in ${SITES_DOC_URL}.`,
    );
    return undefined;
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
    const errors: string[] = validateMetadata(options.metadata);
    // DATADOG_SITE env var takes precedence over configuration; only validate
    // auth.site when no env var is set, so a stale auth.site can't block a
    // build that has already opted into an env override.
    const envRaw = getDDEnvValue('SITE');
    const envSite = resolveSite(envRaw, 'DATADOG_SITE/DD_SITE', errors);

    const auth: AuthOptionsWithDefaults = {
        method: options.auth?.method,
        oauthOptions: options.auth?.oauthOptions,
        site: envSite ?? resolveSite(options.auth?.site, 'auth.site', errors) ?? DEFAULT_SITE,
    };

    if (errors.length) {
        throw new Error(`Invalid Datadog plugin configuration:\n  - ${errors.join('\n  - ')}`);
    }

    // Prevent these from being accidentally logged.
    Object.defineProperty(auth, 'apiKey', {
        value: getDDEnvValue('API_KEY') || options.auth?.apiKey,
        enumerable: false,
    });

    Object.defineProperty(auth, 'appKey', {
        value: getDDEnvValue('APP_KEY') || options.auth?.appKey,
        enumerable: false,
    });

    Object.defineProperty(auth, 'accessToken', {
        value: options.auth?.accessToken,
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
