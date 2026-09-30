// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options } from '@dd/core/types';

import { CONFIG_KEY } from './constants';
import { normalizeTag } from './tags';
import type { AppsOptions, AppsOptionsWithDefaults } from './types';

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

export const resolveTags = (tags: AppsOptions['tags']): AppsOptionsWithDefaults['tags'] => {
    if (tags === undefined) {
        return [];
    }
    if (!Array.isArray(tags)) {
        throw new Error('apps.tags must be an array of strings.');
    }
    const resolved = new Set<string>();
    for (const tag of tags as unknown[]) {
        const normalized = typeof tag === 'string' ? normalizeTag(tag) : undefined;
        if (!normalized) {
            throw new Error(
                `apps.tags must only contain non-empty strings, received ${JSON.stringify(tag)}.`,
            );
        }
        resolved.add(normalized);
    }
    return [...resolved];
};

export const validateOptions = (options: Options): AppsOptionsWithDefaults => {
    const resolvedOptions = (options[CONFIG_KEY] || {}) as AppsOptions;

    return {
        include: resolvedOptions.include || [],
        tags: resolveTags(resolvedOptions.tags),
        longPolling: resolveLongPolling(resolvedOptions.longPolling),
    };
};
