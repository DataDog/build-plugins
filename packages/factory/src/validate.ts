// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { AuthOptionsWithDefaults, Options, OptionsWithDefaults } from '@dd/core/types';

const getEnvValue = (key: string) => {
    return process.env[`DATADOG_${key}`] || process.env[`DD_${key}`];
};

export const validateOptions = (options: Options = {}): OptionsWithDefaults => {
    const auth: AuthOptionsWithDefaults = {
        // DATADOG_SITE env var takes precedence over configuration
        site: getEnvValue('SITE') || options.auth?.site || 'datadoghq.com',
    };

    // Prevent these from being accidentally logged.
    Object.defineProperty(auth, 'apiKey', {
        value: getEnvValue('API_KEY') || options.auth?.apiKey,
        enumerable: false,
    });

    Object.defineProperty(auth, 'appKey', {
        value: getEnvValue('APP_KEY') || options.auth?.appKey,
        enumerable: false,
    });

    return {
        enableGit: true,
        logLevel: 'warn',
        metadata: {},
        ...options,
        auth,
    };
};
