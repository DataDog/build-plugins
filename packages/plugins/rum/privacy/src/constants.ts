// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginName } from '@dd/core/types';

import type { RumPrivacyOptions } from './types';

export const CONFIG_KEY = 'rumPrivacy' as const;
export const PLUGIN_NAME: PluginName = 'datadog-rum-privacy-plugin' as const;
export const PRIVACY_HELPERS_MODULE_ID = '\0datadog:privacy-helpers';

export const defaultPluginOptions: RumPrivacyOptions = {
    exclude: [/\/node_modules\//, /\.preval\./],
    include: [/\.(?:c|m)?(?:j|t)sx?$/],
    module: 'esm',
    jsx: undefined,
    transformStrategy: 'ast',
    typescript: undefined,
    disabled: undefined,
};
