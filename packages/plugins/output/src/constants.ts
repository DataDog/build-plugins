// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginName } from '@dd/core/types';

export const CONFIG_KEY = 'output' as const;
export const PLUGIN_NAME: PluginName = 'datadog-output-plugin' as const;
export const FILE_KEYS = [
    'build',
    'bundler',
    'dependencies',
    'errors',
    'logs',
    'metrics',
    'timings',
    'warnings',
] as const;
