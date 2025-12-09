// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginName } from '@dd/core/types';

export const CONFIG_KEY = 'apps' as const;
export const PLUGIN_NAME: PluginName = 'datadog-apps-plugin' as const;

export const APPS_API_SUBDOMAIN = 'apps-intake';
export const APPS_API_PATH = 'api/v1/apps';
export const ARCHIVE_FILENAME = 'datadog-apps-assets.zip';
