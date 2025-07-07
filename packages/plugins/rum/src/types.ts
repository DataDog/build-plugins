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

// Base SDK options without discriminated union
type BaseSDKOptions = Assign<
    RumInitConfiguration,
    {
        clientToken?: string;
    }
>;

// Discriminated union for SDK options
export type SDKOptions =
    | (Partial<BaseSDKOptions> & { disabled: true }) // When disabled, all properties are optional
    | (BaseSDKOptions & { disabled?: false | undefined }); // When enabled, required properties must be provided

// When disabled is true, use the options as-is. When disabled is false/undefined, make required properties required
export type SDKOptionsWithDefaults = SDKOptions extends { disabled: true }
    ? SDKOptions
    : Assign<
          BaseSDKOptions,
          {
              disabled?: boolean;
          } & Pick<
              Required<BaseSDKOptions>,
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
