// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { DEFAULT_SITE } from '@dd/core/constants';
import { getDDEnvValue } from '@dd/core/helpers/env';
import { parseSite } from '@dd/core/helpers/site';
import type {
    AuthOptionsWithDefaults,
    BuildMetadata,
    Options,
    OptionsWithDefaults,
    SourcemapsOptions,
} from '@dd/core/types';

const SITES_DOC_URL = 'https://docs.datadoghq.com/getting_started/site/';

const resolveSite = (
    value: string | undefined,
    source: string,
    errors: string[],
): ReturnType<typeof parseSite> => {
    if (value === undefined) {
        return undefined;
    }
    const parsed = parseSite(value);
    if (parsed) {
        return parsed;
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

const normalizeSourcemapsOptions = (options: Options, errors: string[]): Options => {
    if (options.sourcemaps === undefined) {
        return options;
    }

    if (
        options.sourcemaps === null ||
        typeof options.sourcemaps !== 'object' ||
        Array.isArray(options.sourcemaps)
    ) {
        errors.push('sourcemaps must be an object');
        return options;
    }

    const sourcemaps = options.sourcemaps as SourcemapsOptions;
    const runtimeOptions = sourcemaps as unknown as Record<string, unknown>;

    if (runtimeOptions.debugId !== true) {
        errors.push('sourcemaps.debugId must be true');
    }
    if (runtimeOptions.upload !== undefined && typeof runtimeOptions.upload !== 'boolean') {
        errors.push('sourcemaps.upload must be a boolean');
    }
    if (
        runtimeOptions.upload !== true &&
        ['bailOnError', 'dryRun', 'maxConcurrency'].some(
            (option) => runtimeOptions[option] !== undefined,
        )
    ) {
        errors.push(
            'sourcemaps.bailOnError, sourcemaps.dryRun, and sourcemaps.maxConcurrency require sourcemaps.upload to be true',
        );
    }
    if (options.rum?.sourceCodeContext !== undefined) {
        errors.push('sourcemaps cannot be combined with rum.sourceCodeContext');
    }
    if (options.rum?.enable === false) {
        errors.push('rum.enable cannot be false when sourcemaps is configured');
    }
    if (options.errorTracking?.sourcemaps !== undefined) {
        errors.push('sourcemaps cannot be combined with errorTracking.sourcemaps');
    }
    if (runtimeOptions.upload === true && options.errorTracking?.enable === false) {
        errors.push('errorTracking.enable cannot be false when sourcemaps.upload is true');
    }

    if (errors.length > 0) {
        return options;
    }

    const normalized: Options = {
        ...options,
        rum: {
            ...options.rum,
            sourceCodeContext: { debugId: true },
        },
    };

    if (sourcemaps.upload === true) {
        normalized.errorTracking = {
            ...options.errorTracking,
            sourcemaps: {
                debugId: true,
                ...(sourcemaps.bailOnError !== undefined && {
                    bailOnError: sourcemaps.bailOnError,
                }),
                ...(sourcemaps.dryRun !== undefined && { dryRun: sourcemaps.dryRun }),
                ...(sourcemaps.maxConcurrency !== undefined && {
                    maxConcurrency: sourcemaps.maxConcurrency,
                }),
            },
        };
    }

    return normalized;
};

export const validateOptions = (options: Options = {}): OptionsWithDefaults => {
    const errors: string[] = validateMetadata(options.metadata);
    const normalizedOptions = normalizeSourcemapsOptions(options, errors);
    // DATADOG_SITE env var takes precedence over configuration; only validate
    // auth.site when no env var is set, so a stale auth.site can't block a
    // build that has already opted into an env override.
    const envRaw = getDDEnvValue('SITE');
    const resolvedSite =
        resolveSite(envRaw, 'DATADOG_SITE/DD_SITE', errors) ??
        resolveSite(normalizedOptions.auth?.site, 'auth.site', errors);

    const auth: AuthOptionsWithDefaults = {
        site: resolvedSite?.site ?? DEFAULT_SITE,
    };

    if (errors.length) {
        throw new Error(`Invalid Datadog plugin configuration:\n  - ${errors.join('\n  - ')}`);
    }

    // Prevent these from being accidentally logged.
    Object.defineProperty(auth, 'apiKey', {
        value: getDDEnvValue('API_KEY') || normalizedOptions.auth?.apiKey,
        enumerable: false,
    });

    Object.defineProperty(auth, 'appKey', {
        value: getDDEnvValue('APP_KEY') || normalizedOptions.auth?.appKey,
        enumerable: false,
    });

    return {
        enableGit: true,
        logLevel: 'warn',
        metadata: {},
        ...normalizedOptions,
        auth,
    };
};
