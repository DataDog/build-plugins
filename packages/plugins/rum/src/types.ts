// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type {
    datadogRum,
    RumInitConfiguration as ExpRumInitConfiguration,
} from '@datadog/browser-rum';
import type { Assign } from '@dd/core/types';

import type { PrivacyOptions, PrivacyOptionsWithDefaults } from './privacy/types';

export type RumOptions = {
    disabled?: boolean;
    sdk?: SDKOptions;
    privacy?: PrivacyOptions;
};

export type RumPublicApi = typeof datadogRum;
export type RumInitConfiguration = ExpRumInitConfiguration;

export type SDKOptions = Assign<
    RumInitConfiguration,
    {
        // We make clientToken optional because we'll try to fetch it via API if absent.
        clientToken?: string;
    }
>;

// Define the SDK options with known defaults.
export type SDKOptionsWithDefaults = Assign<
    SDKOptions,
    Pick<
        Required<SDKOptions>,
        | 'applicationId'
        | 'allowUntrustedEvents'
        | 'compressIntakeRequests'
        | 'defaultPrivacyLevel'
        | 'enablePrivacyForActionName'
        | 'sessionReplaySampleRate'
        | 'sessionSampleRate'
        | 'silentMultipleInit'
        | 'site'
        | 'startSessionReplayRecordingManually'
        | 'storeContextsAcrossPages'
        | 'telemetrySampleRate'
        | 'traceSampleRate'
        | 'trackingConsent'
        | 'trackLongTasks'
        | 'trackResources'
        | 'trackUserInteractions'
        | 'trackViewsManually'
    >
>;

export type RumOptionsWithDefaults = {
    disabled?: boolean;
    sdk?: SDKOptionsWithDefaults;
    privacy?: PrivacyOptionsWithDefaults;
};

export type RumOptionsWithSdk = Assign<RumOptionsWithDefaults, { sdk: SDKOptionsWithDefaults }>;
