// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { WithRequired } from '@dd/core/types';

/** Controls how the dev server retries the Datadog long-poll execution endpoint. */
export type LongPollingOptions = {
    /** Max long-poll attempts. `1` polls once and never retries. Default: `10`. */
    maxRetries?: number;
    /** Randomize retry delays so concurrent pollers don't sync up. Default: `true`. */
    jitter?: boolean;
    /** Grow the delay between retries exponentially. Default: `true`. */
    exponentialBackoff?: boolean;
    /**
     * Deadline for one attempt, in ms. Must stay above the server's ~30s window,
     * otherwise healthy polls get aborted. Default: `40000`.
     */
    timeoutMs?: number;
};

export type AppsOptions = {
    enable?: boolean;
    include?: string[];
    /** Controls how the dev server retries the Datadog long-poll execution endpoint. */
    longPolling?: LongPollingOptions;
};

export type AppsManifest = {
    backend: {
        /** Mapping of encoded query name to information about that backend function. */
        functions: Record<
            string,
            {
                allowedConnectionIds: string[];
            }
        >;
    };
};

export type AppsOptionsWithDefaults = WithRequired<AppsOptions, 'include'> & {
    longPolling: Required<LongPollingOptions>;
};
