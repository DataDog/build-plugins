// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import dts from 'rollup-plugin-dts';
import esbuild from 'rollup-plugin-esbuild';

import packageJson from './package.json' with { type: 'json' };

// `@dd/tools/rollupConfig.mjs` is bundler-plugin specific (it parses the
// package name expecting a `-plugin` suffix and feeds unplugin assumptions
// into the build), so we hand-roll a minimal config here.

const external = [
    ...Object.keys(packageJson.peerDependencies ?? {}),
    ...Object.keys(packageJson.dependencies ?? {}),
    // Externalize ESLint and Node built-ins.
    'eslint',
    'node:path',
    'path',
];

const input = 'src/index.ts';

export default [
    {
        input,
        external,
        output: {
            file: 'dist/src/index.mjs',
            format: 'es',
            sourcemap: true,
        },
        plugins: [
            json(),
            nodeResolve({ preferBuiltins: true }),
            esbuild({ target: 'node18' }),
        ],
    },
    {
        input,
        external,
        output: {
            file: 'dist/src/index.js',
            format: 'cjs',
            sourcemap: true,
            // Rollup's CJS emit for an `export default` source already produces
            // `module.exports = plugin` directly (no `__esModule` wrapping), so
            // legacy `.eslintrc` `require()` returns the plugin directly. The
            // `footer` collapse trick used with esbuild isn't needed here.
        },
        plugins: [
            json(),
            nodeResolve({ preferBuiltins: true }),
            esbuild({ target: 'node18' }),
        ],
    },
    {
        input,
        external,
        output: {
            file: 'dist/src/index.d.ts',
            format: 'es',
        },
        plugins: [dts()],
    },
];
