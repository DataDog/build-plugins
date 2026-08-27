// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginName } from '@dd/core/types';

export const CONFIG_KEY = 'apps' as const;
export const PLUGIN_NAME: PluginName = 'datadog-apps-plugin' as const;

export const APPS_API_PATH = 'api/unstable/app-builder-code/apps';
export const ARCHIVE_FILENAME = 'datadog-apps-assets.zip';
export const BACKEND_FILE_RE = /\.backend\.(ts|tsx|js|jsx)$/;

/** Query suffix marking a local-execution load, so the transform hook below can skip proxy generation for it instead of matching via the broader `options.ssr` flag. */
export const LOCAL_EXECUTION_LOAD_SUFFIX = '?dd-local-exec';
// Matches a backend file with or without ANY trailing query string. A filter scoped only to
// the exact local-execution suffix would let an unrecognized query (e.g. `?x`, or a malformed
// `?dd-local-exec&x`) bypass the transform filter entirely, leaving Vite to load the real
// backend source unprocessed instead of the safe RPC-proxy stub. Matching every query here and
// deciding safety in the handler closes that gap.
export const BACKEND_FILE_WITH_QUERY_RE = new RegExp(
    `${BACKEND_FILE_RE.source.slice(0, -1)}(\\?.*)?$`,
);
export const BACKEND_CODE_EXTENSIONS = [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.mts',
    '.cts',
];
