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

/** One declared parameter, in the shape Datadog stores on the app version. */
export type AppsParameterSchema = {
    name: string;
    type: 'STRING' | 'NUMBER' | 'BOOLEAN';
    defaultValue: string | number | boolean;
    label?: string;
    description?: string;
    enum?: readonly string[];
};

/** The value returned by `defineDatadogAppParameters()` from `@datadog/apps-frontend/parameters`. */
export type AppsParameters = {
    readonly schema: readonly AppsParameterSchema[];
};

export type AppsOptions = {
    enable?: boolean;
    include?: string[];
    /**
     * Tags to add to the app, e.g. `team:my-team`. The package also carries a `surface:<id>` tag
     * for each surface declared by an `@datadog/apps-frontend` input the app uses.
     */
    tags?: string[];
    /** Controls how the dev server retries the Datadog long-poll execution endpoint. */
    longPolling?: LongPollingOptions;
    /**
     * Overrides the parameters found in app code. By default the build reads
     * every `defineDatadogAppParameters({...})` call, so this is only needed
     * for declarations the build cannot read.
     */
    parameters?: AppsParameters;
};

export type AppsManifest = {
    /**
     * Tags to add to the app (authored tags and derived `surface:<id>` tags), sorted.
     * The backend adds them to the app's tags and never removes any.
     */
    tags: string[];
    /**
     * The app's complete parameter declaration, replacing the stored one. Absent
     * only in manifests from older plugins, which keeps the stored declaration.
     */
    inputSchema?: {
        parameters: AppsParameterSchema[];
    };
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

export type AppsOptionsWithDefaults = Omit<WithRequired<AppsOptions, 'include'>, 'parameters'> & {
    longPolling: Required<LongPollingOptions>;
    parameters?: AppsParameterSchema[];
};
