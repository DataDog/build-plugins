// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import babel from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import fs from 'fs';
import modulePackage from 'module';
import { createRequire } from 'node:module';
import path from 'path';
import dts from 'rollup-plugin-dts';
import esbuild from 'rollup-plugin-esbuild';

/**
 * @param {import('rollup').RollupOptions} config
 * @returns {import('rollup').RollupOptions}
 */
export const bundle = (config) => ({
    ...config,
    input: 'src/index.ts',
    external: [
        // These are peer dependencies
        'webpack',
        'esbuild',
        'vite',
        'rollup',
        // These should be internal only and never be anywhere published.
        '@dd/core',
        '@dd/tools',
        '@dd/tests',
        // We never want to include Node.js built-in modules in the bundle.
        ...modulePackage.builtinModules,
    ],
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
    output: {
        exports: 'named',
        sourcemap: true,
        // This is to prevent overrides from other libraries in the final bundle.
        // "outdent" for instance does override the default value of `exports`.
        outro: (rendered) => {
            return `
if (typeof module !== 'undefined') {
    module.exports = {
        ${rendered.exports.join(',\n        ')}
    };
}
`;
        },
        ...config.output,
    },
});

/**
 * @param {{module: string; main: string;}} packageJson
 * @returns {import('rollup').RollupOptions[]}
 */
export const getDefaultBuildConfigs = (packageJson) => [
    bundle({
        plugins: [
            esbuild(),
            {
                name: 'copy-unplugin-loaders',
                writeBundle(options) {
                    // Unplugins comes with loaders that need to be copied in place
                    // to be usable.
                    const outputDir = options.dir || path.dirname(options.file);
                    const require = createRequire(import.meta.url);
                    const unpluginDir = path.dirname(require.resolve('unplugin'));
                    fs.cpSync(
                        path.resolve(unpluginDir, 'webpack'),
                        path.resolve(outputDir, 'webpack'),
                        { recursive: true },
                    );
                    fs.cpSync(
                        path.resolve(unpluginDir, 'rspack'),
                        path.resolve(outputDir, 'rspack'),
                        {
                            recursive: true,
                        },
                    );
                },
            },
        ],
        output: {
            file: packageJson.module,
            format: 'esm',
        },
    }),
    bundle({
        plugins: [esbuild()],
        output: {
            file: packageJson.main,
            format: 'cjs',
        },
    }),
    bundle({
        plugins: [dts()],
        output: {
            dir: 'dist/src',
        },
    }),
];
