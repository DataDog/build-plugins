// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export const INJECTED_FILE = '__datadog-helper-file';

export const ALL_ENVS = ['development', 'production', 'test'] as const;
export const ALL_BUNDLERS = ['webpack', 'vite', 'esbuild', 'rollup', 'rspack', 'rolldown', 'farm'];
export const SUPPORTED_BUNDLERS = ['webpack', 'vite', 'esbuild', 'rollup', 'rspack'] as const;
export const FULL_NAME_BUNDLERS = [
    'esbuild',
    'rollup',
    'rspack',
    'vite',
    'webpack4',
    'webpack5',
] as const;
export const ENV_VAR_REQUESTED_BUNDLERS = 'PLAYWRIGHT_REQUESTED_BUNDLERS';

export const HOST_NAME = 'datadog-build-plugins';
