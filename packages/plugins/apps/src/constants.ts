// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginName } from '@dd/core/types';

export const CONFIG_KEY = 'apps' as const;
export const PLUGIN_NAME: PluginName = 'datadog-apps-plugin' as const;

export const APPS_API_PATH = 'api/unstable/app-builder-code/apps';
export const ARCHIVE_FILENAME = 'datadog-apps-assets.zip';
export const BACKEND_FILE_RE = /\.backend\.(ts|tsx|js|jsx)$/;

/** Query suffix marking a local-execution load, so the transform hook can target it directly instead of matching on the broader `options.ssr` flag. */
export const LOCAL_EXECUTION_LOAD_SUFFIX = '?dd-local-exec';
// Matches a backend file with any (or no) trailing query string — scoping only to the exact local-execution suffix would let an unrecognized query slip past this filter and leak the real backend source instead of the safe proxy stub; the handler decides safety per case.
export const BACKEND_FILE_WITH_QUERY_RE = new RegExp(
    `${BACKEND_FILE_RE.source.slice(0, -1)}(\\?.*)?$`,
);

/** Vite's own `--mode` value for `npm run dev:verify`, read server-side from `server.config.mode` rather than `import.meta.env.MODE`, which has no CommonJS equivalent and breaks Jest's ts-jest transform. */
export const DEV_VERIFY_MODE = 'dev-verify';
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
