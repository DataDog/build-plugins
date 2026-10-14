// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDDEnvValue } from '@dd/core/helpers/env';
import type { Options } from '@dd/core/types';

import { CONFIG_KEY } from './constants';
import { BACKEND_ENVIRONMENTS } from './types';
import type { AppsOptions, AppsOptionsWithDefaults, BackendEnvironment } from './types';

export const resolveLongPolling = (
    longPolling: AppsOptions['longPolling'],
): AppsOptionsWithDefaults['longPolling'] => {
    const maxRetries = longPolling?.maxRetries ?? 10;
    const timeoutMs = longPolling?.timeoutMs ?? 40_000;

    if (!Number.isInteger(maxRetries) || maxRetries < 1) {
        throw new Error('apps.longPolling.maxRetries must be an integer >= 1.');
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('apps.longPolling.timeoutMs must be a positive number.');
    }

    return {
        maxRetries,
        timeoutMs,
        jitter: longPolling?.jitter ?? true,
        exponentialBackoff: longPolling?.exponentialBackoff ?? true,
    };
};

// DATADOG_APPS_BACKEND_ENVIRONMENT wins over the config so the CLI can set it per upload.
export const resolveBackendEnvironment = (
    configured: AppsOptions['backendEnvironment'],
): BackendEnvironment | undefined => {
    const value = getDDEnvValue('APPS_BACKEND_ENVIRONMENT')?.trim() || configured;
    if (value === undefined) {
        return undefined;
    }
    if (!(BACKEND_ENVIRONMENTS as readonly string[]).includes(value)) {
        throw new Error(
            `apps.backendEnvironment must be one of ${BACKEND_ENVIRONMENTS.map((env) => `'${env}'`).join(', ')}; got '${value}'.`,
        );
    }
    return value as BackendEnvironment;
};

export const validateOptions = (options: Options): AppsOptionsWithDefaults => {
    const resolvedOptions = (options[CONFIG_KEY] || {}) as AppsOptions;

    const backendEnvironment = resolveBackendEnvironment(resolvedOptions.backendEnvironment);

    return {
        include: resolvedOptions.include || [],
        // Passed through as configured; the authored tag source cleans it, best effort.
        tags: resolvedOptions.tags,
        longPolling: resolveLongPolling(resolvedOptions.longPolling),
        ...(backendEnvironment && { backendEnvironment }),
    };
};
