import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import modulePackage from 'module';
import dts from 'rollup-plugin-dts';
import esbuild from 'rollup-plugin-esbuild';

import packageJson from './package.json' assert { type: 'json' };

// These are for webpack.
const IGNORE_WARNING_CODES = []; // ['CIRCULAR_DEPENDENCY', 'EVAL'];
const IGNORE_WARNING_MESSAGES = []; // ['"@swc/core" is imported by', '"uglify-js" is imported by'];

/**
 * @param {import('rollup').RollupOptions} config
 * @returns {import('rollup').RollupOptions}
 */
const bundle = (config) => ({
    ...config,
    input: 'src/index.ts',
    external: [...Object.keys(packageJson.peerDependencies ?? []), ...modulePackage.builtinModules],
    plugins: [json(), commonjs(), nodeResolve({ preferBuiltins: true }), ...config.plugins],
    onwarn: (warning) => {
        if (
            !IGNORE_WARNING_CODES.includes(warning.code) &&
            !IGNORE_WARNING_MESSAGES.some((message) => warning.message.startsWith(message))
        ) {
            console.warn(warning.message);
        }
    },
    output: {
        dir: 'dist',
        exports: 'named',
        format: 'es',
        sourcemap: true,
    },
});

export default [
    bundle({
        plugins: [esbuild()],
    }),
    bundle({
        plugins: [dts()],
    }),
];
