// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginName } from '@dd/core/types';

export const PLUGIN_NAME: PluginName = 'datadog-rum-privacy-plugin' as const;
export const PRIVACY_HELPERS_FILE_NAME = 'privacy-helpers';
export const PRIVACY_HELPERS_MODULE_ID = `\0datadog:${PRIVACY_HELPERS_FILE_NAME}`;
