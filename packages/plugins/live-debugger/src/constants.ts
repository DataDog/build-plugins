// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginName } from '@dd/core/types';

export const CONFIG_KEY = 'liveDebugger' as const;
export const PLUGIN_NAME: PluginName = 'datadog-live-debugger-plugin' as const;

// Skip instrumentation comment
export const SKIP_INSTRUMENTATION_COMMENT = '@dd-no-instrumentation';

// Runtime global that instrumented functions call when they throw.
// The symbol table relies on it marking the end of every instrumented function's body.
export const LIVE_DEBUGGER_THROW_FUNCTION = '$dd_throw';

// Function IDs are `<build-root-relative path>;<function name>`.
export const FUNCTION_ID_SEPARATOR = ';';
// Function name used in the IDs of anonymous functions, followed by their location.
export const ANONYMOUS_FUNCTION_NAME = '<anonymous>';

// Path where an opt-in debug dump of the symbol table is written.
// Until the symbol table upload exists, setting it is also what enables the symbol table.
export const SYMBOL_TABLE_PATH_ENV = 'DD_LIVE_DEBUGGER_SYMBOL_TABLE_PATH';

export const DEFAULT_FILE_EXTENSIONS = [
    '.js',
    '.jsx',
    '.ts',
    '.tsx',
    '.mjs',
    '.cjs',
    '.mts',
    '.cts',
] as const;
