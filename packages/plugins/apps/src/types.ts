// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Assign, WithRequired } from '@dd/core/types';

export type AuthMethod = 'apiKey' | 'oauth';

export type AppsProtectionLevel = 'direct_publish' | 'approval_required';

export type AppsOptions = {
    enable?: boolean;
    include?: string[];
    dryRun?: boolean;
    identifier?: string;
    name?: string;
    /** Human-readable description of the app. */
    description?: string;
    /** When true, the app appears in the Datadog self-service catalog. */
    selfService?: boolean;
    /** Deployment and identity settings for the app. */
    permissions?: {
        /**
         * Controls whether publishing the app requires a second approver.
         * - `direct_publish`: any user with publish rights can deploy immediately.
         * - `approval_required`: a second user must approve before the app goes live.
         */
        protectionLevel?: AppsProtectionLevel;
        /**
         * UUID of the service account the app's backend functions run as.
         * When omitted the app runs as the uploading user.
         * Only service accounts are accepted; arbitrary user UUIDs are rejected by the API.
         */
        runAs?: string;
    };
    // Per-app auth overrides. `method` is scoped here rather than on the shared
    // `auth` config because not every product endpoint supports OAuth.
    authOverrides?: {
        method?: AuthMethod;
    };
    /**
     * IDs of Custom Credentials connections (secret stores managed via `yarn cli apps-secrets`)
     * to make available to every backend function, regardless of whether its code references
     * a connectionId. Merged into each function's allowedConnectionIds at build time.
     */
    secretConnections?: string[];
};

export type AppsManifest = {
    /** Human-readable description of the app. */
    description?: string;
    /** When true, the app appears in the Datadog self-service catalog. */
    selfService?: boolean;
    /** Deployment and identity settings for the app. */
    permissions?: {
        protectionLevel?: AppsProtectionLevel;
        runAs?: string;
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

// We don't enforce identifier, as it needs to be dynamically computed if absent.
export type AppsOptionsWithDefaults = Omit<
    Assign<
        WithRequired<AppsOptions, 'include' | 'dryRun'>,
        {
            authOverrides: {
                method: AuthMethod;
            };
        }
    >,
    'enable'
>;
