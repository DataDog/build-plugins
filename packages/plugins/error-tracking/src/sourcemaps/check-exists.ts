// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getCheckExistsBatches } from '@datadog/sourcemaps-shared';
import { doRequest, getOriginHeaders } from '@dd/core/helpers/request';

const CHECK_EXISTS_TIMEOUT_MS = 1000;

export const CHECK_EXISTS_API_PATH = 'api/unstable/sourcemaps/check_exists';

export const getCheckExistsUrl = (site: string) => `https://api.${site}/${CHECK_EXISTS_API_PATH}`;

type CheckExistsResponse = {
    data?: {
        attributes?: {
            // Untrusted wire values: only an explicit `true` counts as existing.
            results?: Record<string, unknown>;
        };
    };
};

export type CheckExistsContext = {
    apiKey: string;
    bundlerName: string;
    site: string;
    version: string;
};

// Returns the debug IDs Datadog already holds a sourcemap for.
// Throws on a failed request or an unexpected response shape, so the caller can decide to
// fail open and upload everything rather than skip a sourcemap that is actually missing.
export const getExistingDebugIds = async (
    debugIds: string[],
    context: CheckExistsContext,
): Promise<Set<string>> => {
    const existingDebugIds = new Set<string>();
    if (debugIds.length === 0) {
        return existingDebugIds;
    }

    const originHeaders = getOriginHeaders({
        bundler: context.bundlerName,
        plugin: 'sourcemaps',
        version: context.version,
    });

    for (const chunk of getCheckExistsBatches(debugIds)) {
        const body = JSON.stringify({
            data: { type: 'check_exists', attributes: { debug_ids: chunk } },
        });
        // The endpoint speaks JSON:API on the wire.
        const requestData = {
            data: body,
            headers: {
                'Content-Type': 'application/vnd.api+json',
                ...originHeaders,
            },
        };

        // One signal per request: its timeout starts counting when it is created.
        const timeoutSignal = AbortSignal.timeout(CHECK_EXISTS_TIMEOUT_MS);

        // The chunks are independent, but sending them one after the other keeps the request
        // count predictable when a build carries a very large number of sourcemaps.
        // eslint-disable-next-line no-await-in-loop
        const response = await doRequest<CheckExistsResponse>({
            auth: { apiKey: context.apiKey },
            method: 'POST',
            // Best effort: a failed or slow check uploads everything anyway, so fail fast.
            retries: 0,
            signal: timeoutSignal,
            type: 'json',
            url: getCheckExistsUrl(context.site),
            getData: () => requestData,
        });

        const results = response?.data?.attributes?.results;
        if (results === undefined) {
            throw new Error('Invalid check_exists response: missing results.');
        }

        for (const [debugId, exists] of Object.entries(results)) {
            if (exists === true) {
                existingDebugIds.add(debugId);
            }
        }
    }

    return existingDebugIds;
};
