// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export const typesOfPlugin = ['universal', 'bundler'] as const;

export const bundlerHooks = ['webpack', 'esbuild', 'vite', 'rollup', 'rspack', 'farm'] as const;

export const universalHooks = [
    'enforce',
    'buildStart',
    'resolveId',
    'load',
    'transform',
    'watchChange',
    'buildEnd',
    'writeBundle',
] as const;
