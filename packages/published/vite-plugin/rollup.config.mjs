import { bundle, getDefaultBuildConfigs } from '@dd/tools/rollupConfig.mjs';
// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
import path from 'path';
import esbuild from 'rollup-plugin-esbuild';

import packageJson from './package.json' with { type: 'json' };

const CWD = process.env.PROJECT_CWD || process.cwd();

const cliConfig = bundle(packageJson, {
    plugins: [esbuild()],
    input: {
        cli: path.join(CWD, 'packages/plugins/apps/src/cli.ts'),
    },
    output: {
        banner: '#!/usr/bin/env node',
        dir: 'dist/src',
        entryFileNames: '[name].js',
        format: 'cjs',
        sourcemap: false,
    },
});

export default (async () => {
    const defaultConfigs = await getDefaultBuildConfigs(packageJson);
    return [...defaultConfigs, cliConfig];
})();
