// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { UnpluginOptions } from 'unplugin';

import type { Context as PluginsContext } from './plugins';

export type GetPlugins<T> = (options: T, context: PluginsContext) => UnpluginOptions[];

export type LogLevel = 'debug' | 'warn' | 'error' | 'none';

export interface GetPluginsOptions {
    auth?: {
        apiKey?: string;
        endPoint?: string;
    };
    logLevel?: LogLevel;
}

export type PluginName = `datadog-${Lowercase<string>}-plugin`;
