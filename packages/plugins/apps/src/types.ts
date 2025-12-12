// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { WithRequired } from '@dd/core/types';

export type AppsOptions = {
    enable?: boolean;
    include?: string[];
    dryRun?: boolean;
    identifier?: string;
};

// We don't enforce identifier, as it needs to be dynamically computed if absent.
export type AppsOptionsWithDefaults = WithRequired<AppsOptions, 'enable' | 'include' | 'dryRun'>;
