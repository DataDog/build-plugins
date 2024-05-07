// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDefaultBuildConfigs } from '@dd/tools/rollupConfig.mjs';
import multi from '@rollup/plugin-multi-entry';

import packageJson from './package.json' assert { type: 'json' };

export default getDefaultBuildConfigs(packageJson).map((config) => {
    config.plugins.push(multi({ preserveModules: true }));

    config.input = { include: 'src/*.ts' };

    delete config.output.file;
    config.output.dir = 'dist';
    config.output.preserveModules = true;

    return config;
});
