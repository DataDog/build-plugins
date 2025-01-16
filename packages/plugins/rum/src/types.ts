// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Assign, GetPluginsOptions } from '@dd/core/types';

import type { CONFIG_KEY } from './constants';

export type RumOptions = {
    disabled?: boolean;
    sdk?: SDKOptions;
};

export type SDKOptions = {
    actionNameAttribute?: string;
    allowedTracingUrls?: string[];
    allowUntrustedEvents?: boolean;
    applicationId: string;
    clientToken?: string;
    compressIntakeRequests?: boolean;
    defaultPrivacyLevel?: 'mask' | 'mask-user-input' | 'allow';
    enablePrivacyForActionName?: boolean;
    env?: string;
    excludedActivityUrls?: string[];
    proxy?: string;
    service?: string;
    sessionReplaySampleRate?: number;
    sessionSampleRate?: number;
    silentMultipleInit?: boolean;
    site?: string;
    startSessionReplayRecordingManually?: boolean;
    storeContextsAcrossPages?: boolean;
    telemetrySampleRate?: number;
    traceSampleRate?: number;
    trackingConsent?: 'granted' | 'not_granted';
    trackLongTasks?: boolean;
    trackResources?: boolean;
    trackUserInteractions?: boolean;
    trackViewsManually?: boolean;
    version?: string;
    workerUrl?: string;
};

export type SDKOptionsWithDefaults = Assign<
    Required<SDKOptions>,
    {
        // This one, we'll try to fetch it via API.
        clientToken?: string;
    } & {
        // These have no default and are trully optional.
        actionNameAttribute?: string;
        allowedTracingUrls?: string[];
        env?: string;
        excludedActivityUrls?: string[];
        proxy?: string;
        service?: string;
        version?: string;
        workerUrl?: string;
    }
>;

export type RumOptionsWithDefaults = {
    disabled?: boolean;
    sdk?: SDKOptionsWithDefaults;
};

export type RumOptionsWithSdk = Assign<RumOptionsWithDefaults, { sdk: SDKOptionsWithDefaults }>;

export interface OptionsWithRum extends GetPluginsOptions {
    [CONFIG_KEY]: RumOptions;
}
