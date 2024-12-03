// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import babel from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import modulePackage from 'module';
import path from 'path';
import dts from 'rollup-plugin-dts';
import esbuild from 'rollup-plugin-esbuild';
import url from 'url';

const dirname = path.dirname(url.fileURLToPath(import.meta.url));

/**
 * @param {{module: string; main: string;}} packageJson
 * @param {import('rollup').RollupOptions} config
 * @returns {import('rollup').RollupOptions}
 */
export const bundle = (packageJson, config) => ({
    input: 'src/index.ts',
    ...config,
    external: [
        // All peer dependencies are external dependencies.
        ...Object.keys(packageJson.peerDependencies),
        // All dependencies are external dependencies.
        ...Object.keys(packageJson.dependencies),
        // These should be internal only and never be anywhere published.
        '@dd/core',
        '@dd/tools',
        '@dd/tests',
        // This is for the rumReactPlugin.ts file.
        'react',
        'react-router-dom',
        // We never want to include Node.js built-in modules in the bundle.
        ...modulePackage.builtinModules,
    ],
    onwarn(warning, warn) {
        // Ignore warnings about undefined `this`.
        if (warning.code === 'THIS_IS_UNDEFINED') {
            return;
        }
        warn(warning);
    },
    plugins: [
        babel({
            babelHelpers: 'bundled',
            include: ['src/**/*'],
        }),
        json(),
        commonjs(),
        nodeResolve({ preferBuiltins: true }),
        ...config.plugins,
    ],
});

/**
 * @param {{module: string; main: string;}} packageJson
 * @returns {import('rollup').RollupOptions[]}
 */
export const getDefaultBuildConfigs = (packageJson) => [
    bundle(packageJson, {
        plugins: [esbuild()],
        input: {
            // Main bundle.
            index: 'src/index.ts',
            // Rum React plugin bundle.
            'rum-react-plugin': path.join(dirname, './build/rumReactPlugin.ts'),
            // Rum React Router plugin bundle.
            'rum-react-router-6': path.join(dirname, './build/rumReactRouter6.ts'),
        },
        output: [
            {
                exports: 'named',
                sourcemap: true,
                entryFileNames: `[name]${path.extname(packageJson.module)}`,
                dir: path.dirname(packageJson.module),
                plugins: [terser()],
                format: 'esm',
            },
            {
                exports: 'named',
                sourcemap: true,
                entryFileNames: `[name]${path.extname(packageJson.main)}`,
                dir: path.dirname(packageJson.main),
                plugins: [terser()],
                format: 'cjs',
            },
        ],
    }),
    // Type definitions.
    // FIXME: This build is sloooow.
    bundle(packageJson, {
        plugins: [dts()],
        output: {
            exports: 'named',
            sourcemap: true,
            dir: 'dist/src',
        },
    }),
];
