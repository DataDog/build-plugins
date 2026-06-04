// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginName } from '@dd/core/types';

export const PLUGIN_NAME: PluginName = 'datadog-error-tracking-debug-id-plugin' as const;

// JS output extensions we inject the debug_id into.
export const SUPPORTED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
