// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Options, OptionsWithDefaults } from '@dd/core/types';

export const validateOptions = (options: Options = {}): OptionsWithDefaults => {
    return {
        auth: {},
        disableGit: false,
        logLevel: 'warn',
        ...options,
    };
};
