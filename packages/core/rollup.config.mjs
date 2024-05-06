import { getDefaultBuildConfigs } from '@dd/tools/rollupConfig.mjs';
import multi from '@rollup/plugin-multi-entry';

import packageJson from './package.json' assert { type: 'json' };

export default getDefaultBuildConfigs(packageJson).map((config) => {
    config.plugins.push(multi({ preserveModules: true }));

    config.input = { include: 'src/*.ts' };

    delete config.output.file;
    config.output.dir = 'dist/src';

    config.output.preserveModules = true;

    return config;
});
