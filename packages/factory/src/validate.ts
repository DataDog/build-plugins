// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDDEnvValue } from '@dd/core/helpers/env';
import type {
    AuthOptionsWithDefaults,
    BuildMetadata,
    Options,
    OptionsWithDefaults,
} from '@dd/core/types';

const validateMetadata = (metadata: BuildMetadata | undefined): string[] => {
    const errors: string[] = [];
    if (metadata === undefined) {
        return errors;
    }
    // TODO(next-major): also reject non-string `metadata.name`. Skipped today
    // because `metadata.name` has historically been unvalidated (and the root
    // README documents its default as `null`), so adding a type-check here
    // would be a breaking change for users who took the docs literally.
    if (metadata.version !== undefined && typeof metadata.version !== 'string') {
        errors.push('metadata.version must be a string');
    }
    return errors;
};

export const validateOptions = (options: Options = {}): OptionsWithDefaults => {
    const errors: string[] = [...validateMetadata(options.metadata)];

    if (errors.length) {
        throw new Error(`Invalid Datadog plugin configuration:\n  - ${errors.join('\n  - ')}`);
    }

    const auth: AuthOptionsWithDefaults = {
        // DATADOG_SITE env var takes precedence over configuration
        site: getDDEnvValue('SITE') || options.auth?.site || 'datadoghq.com',
    };

    // Prevent these from being accidentally logged.
    Object.defineProperty(auth, 'apiKey', {
        value: getDDEnvValue('API_KEY') || options.auth?.apiKey,
        enumerable: false,
    });

    Object.defineProperty(auth, 'appKey', {
        value: getDDEnvValue('APP_KEY') || options.auth?.appKey,
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
