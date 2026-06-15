// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Assign, WithRequired } from '@dd/core/types';

export type AuthMethod = 'apiKey' | 'oauth';

export type AppsOptions = {
    enable?: boolean;
    include?: string[];
    dryRun?: boolean;
    identifier?: string;
    name?: string;
    // Per-app auth overrides. `method` is scoped here rather than on the shared
    // `auth` config because not every product endpoint supports OAuth.
    authOverrides?: {
        method?: AuthMethod;
    };
    // When false, skips the release/live call after upload so the app is saved
    // as a draft without being published. Defaults to true. Can also be set via
    // the DD_APPS_PUBLISH=false environment variable.
    publish?: boolean;
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

// We don't enforce identifier, as it needs to be dynamically computed if absent.
export type AppsOptionsWithDefaults = Omit<
    Assign<
        WithRequired<AppsOptions, 'include' | 'dryRun' | 'publish'>,
        {
            authOverrides: {
                method: AuthMethod;
            };
        }
    >,
    'enable'
>;
