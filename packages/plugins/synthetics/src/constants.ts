// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginName } from '@dd/core/types';

export const CONFIG_KEY = 'synthetics' as const;
export const PLUGIN_NAME: PluginName = 'datadog-synthetics-plugin' as const;

export const API_PREFIX = '_datadog-ci_' as const;
export const DEFAULT_PORT = 1234 as const;
