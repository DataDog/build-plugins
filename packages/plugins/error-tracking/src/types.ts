// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPluginsOptionsWithCWD } from '@dd/core/types';

import type { CONFIG_KEY } from './constants';

export type ErrorTrackingOptions = {
    disabled?: boolean;
};

export interface ErrorTrackingOptionsEnabled extends ErrorTrackingOptions {
    disabled?: false;
}

export interface OptionsWithErrorTrackingEnabled extends GetPluginsOptionsWithCWD {
    [CONFIG_KEY]: ErrorTrackingOptionsEnabled;
}
