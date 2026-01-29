// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger, Options, OptionsWithDefaults } from '@dd/core/types';
import chalk from 'chalk';

import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import type { PrivacyOptionsWithDefaults } from './privacy/types';
import type {
    RumOptions,
    RumOptionsWithDefaults,
    SDKOptionsWithDefaults,
    SourceCodeContextOptions,
} from './types';

export const validateOptions = (
    options: OptionsWithDefaults,
    log: Logger,
): RumOptionsWithDefaults => {
    const errors: string[] = [];

    // Validate and add defaults sub-options.
    const sdkResults = validateSDKOptions(options);
    const privacyResults = validatePrivacyOptions(options);
    const sourceCodeContextResults = validateSourceCodeContextOptions(options);

    errors.push(...sdkResults.errors);
    errors.push(...privacyResults.errors);
    errors.push(...sourceCodeContextResults.errors);

    // Throw if there are any errors.
    if (errors.length) {
        log.error(`\n  - ${errors.join('\n  - ')}`);
        throw new Error(`Invalid configuration for ${PLUGIN_NAME}.`);
    }

    // Build the final configuration.
    const toReturn: RumOptionsWithDefaults = {
        enable: !!options[CONFIG_KEY],
        ...options[CONFIG_KEY],
        sdk: undefined,
        privacy: undefined,
        sourceCodeContext: undefined,
    };

    // Fill in the defaults.
    if (sdkResults.config) {
        toReturn.sdk = sdkResults.config;
    }

    if (privacyResults.config) {
        toReturn.privacy = privacyResults.config;

        log.debug(
            `datadog-rum-privacy plugin options: ${JSON.stringify(toReturn.privacy, (_, value) => {
                if (value instanceof RegExp) {
                    return value.toString();
                }
                return value;
            })}`,
            { forward: true },
        );
    }

    if (sourceCodeContextResults.config) {
        toReturn.sourceCodeContext = sourceCodeContextResults.config;
    }

    return toReturn;
};

type ToReturn<T> = {
    errors: string[];
    config?: T;
};

export const validateSDKOptions = (
    options: OptionsWithDefaults,
): ToReturn<SDKOptionsWithDefaults> => {
    const red = chalk.bold.red;
    const validatedOptions: RumOptions = options[CONFIG_KEY] || {};
    const toReturn: ToReturn<SDKOptionsWithDefaults> = {
        errors: [],
    };
    if (!validatedOptions.sdk) {
        return toReturn;
    }

    // Validate the configuration.
    if (!validatedOptions.sdk.applicationId) {
        toReturn.errors.push(`Missing ${red('applicationId')} in the SDK configuration.`);
    }

    // Check if we have all we need to fetch the client token if necessary.
    if ((!options.auth.apiKey || !options.auth.appKey) && !validatedOptions.sdk.clientToken) {
        toReturn.errors.push(
            `Missing ${red('"auth.apiKey"')} and/or ${red('"auth.appKey"')} to fetch missing client token.`,
        );
    }

    const sdkWithDefault: SDKOptionsWithDefaults = {
        applicationId: 'unknown_application_id',
        allowUntrustedEvents: false,
        compressIntakeRequests: false,
        defaultPrivacyLevel: 'mask',
        enablePrivacyForActionName: false,
        sessionReplaySampleRate: 0,
        sessionSampleRate: 100,
        silentMultipleInit: false,
        site: 'datadoghq.com',
        startSessionReplayRecordingManually: false,
        storeContextsAcrossPages: false,
        telemetrySampleRate: 20,
        traceSampleRate: 100,
        trackingConsent: 'granted',
        trackLongTasks: false,
        trackResources: false,
        trackUserInteractions: false,
        trackViewsManually: false,
    };

    // Save the config.
    toReturn.config = {
        ...sdkWithDefault,
        ...validatedOptions.sdk,
    };

    return toReturn;
};

export const validatePrivacyOptions = (options: Options): ToReturn<PrivacyOptionsWithDefaults> => {
    const validatedOptions: RumOptions = options[CONFIG_KEY] || {};
    const toReturn: ToReturn<PrivacyOptionsWithDefaults> = {
        errors: [],
    };

    if (validatedOptions.privacy) {
        const privacyWithDefault: PrivacyOptionsWithDefaults = {
            // Exclude dependencies and preval files from being transformed. Files starting with
            // special characters are likely to be virtual libraries and are excluded to avoid loading them.
            exclude: [/\/node_modules\//, /\.preval\./, /^[!@#$%^&*()=+~`-]/],
            include: [/\.(?:c|m)?(?:j|t)sx?$/],
            addToDictionaryFunctionName: '$',
            helperCodeExpression: `/*__PURE__*/((q='$DD_A_Q',g=globalThis)=>(g[q]=g[q]||[],(v=>(g[q].push(v),v))))()`,
        };

        toReturn.config = {
            ...privacyWithDefault,
            ...validatedOptions.privacy,
        };
    }

    return toReturn;
};

export const validateSourceCodeContextOptions = (
    options: OptionsWithDefaults,
): ToReturn<SourceCodeContextOptions> => {
    const red = chalk.bold.red;
    const validatedOptions: RumOptions = options[CONFIG_KEY] || {};
    const toReturn: ToReturn<SourceCodeContextOptions> = {
        errors: [],
    };

    if (!validatedOptions.sourceCodeContext) {
        return toReturn;
    }

    const cfg: SourceCodeContextOptions = validatedOptions.sourceCodeContext;

    if (!cfg?.service || typeof cfg.service !== 'string') {
        toReturn.errors.push(`Missing ${red('"rum.sourceCodeContext.service"')}.`);
    }

    toReturn.config = cfg;
    return toReturn;
};
