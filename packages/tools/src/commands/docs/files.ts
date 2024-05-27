// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs-extra';
import { outdent } from 'outdent';
import path from 'path';

import { CONFIGS_KEY, HELPERS_KEY, IMPORTS_KEY, ROOT, TYPES_KEY } from '../../constants';
import { getCamelCase, getPascalCase, getUpperCase, green, replaceInBetween } from '../../helpers';
import type { Plugin } from '../../types';

const updateFactory = (plugins: Plugin[]) => {
    const factoryPath = path.resolve(ROOT, 'packages/factory/src/index.ts');
    let factoryContent = fs.readFileSync(factoryPath, 'utf-8');

    let importContent = '';
    let typeContent = '';
    let configContent = '';
    let helperContent = '';

    plugins.forEach((plugin, i) => {
        console.log(`    Inject ${green(plugin.name)} into ${green('packages/factory')}.`);

        const pascalCase = getPascalCase(plugin.slug);
        const camelCase = getCamelCase(plugin.slug);
        const upperCase = getUpperCase(plugin.slug);

        if (i > 0) {
            importContent += '\n';
            typeContent += '\n';
            configContent += '\n';
            helperContent += '\n';
        }

        // Prepare content.
        importContent += outdent`
            import type { OptionsWith${pascalCase}Enabled, ${pascalCase}Options } from '${plugin.name}/types';
            import{
                helpers as ${camelCase}Helpers,
                getPlugins as get${pascalCase}Plugins,
                CONFIG_KEY as ${upperCase}_CONFIG_KEY,
            } from '${plugin.name}';
        `;
        typeContent += `[${upperCase}_CONFIG_KEY]?: ${pascalCase}Options,`;
        configContent += outdent`
            if (options[${upperCase}_CONFIG_KEY] && options[${upperCase}_CONFIG_KEY].disabled !== true) {
                plugins.push(...get${pascalCase}Plugins(options as OptionsWith${pascalCase}Enabled));
            }
        `;
        helperContent += `[${upperCase}_CONFIG_KEY]?: ${camelCase}Options,`;
    });

    // Update contents.
    factoryContent = replaceInBetween(factoryContent, IMPORTS_KEY, importContent);
    factoryContent = replaceInBetween(factoryContent, TYPES_KEY, typeContent);
    factoryContent = replaceInBetween(factoryContent, CONFIGS_KEY, configContent);
    factoryContent = replaceInBetween(factoryContent, HELPERS_KEY, helperContent);

    // console.log(factoryContent);

    // Write back to file.
    console.log(`  Write ${green('packages/factory/src/index.ts')}.`);
    fs.writeFileSync(factoryPath, factoryContent, { encoding: 'utf-8' });
};

const updatePackageJson = (plugins: Plugin[]) => {
    const factoryPackagePath = path.resolve(ROOT, 'packages/factory/package.json');
    const factoryPackage = fs.readJsonSync(factoryPackagePath);

    plugins.forEach((plugin) => {
        console.log(
            `    Add ${green(`@dd/${plugin.name}`)} dependency to ${green('packages/factory')}.`,
        );
        factoryPackage.dependencies[`@dd/${plugin.name}-plugins`] = 'workspace:*';
    });

    console.log(`  Write ${green('packages/factory/package.json')}.`);
    fs.writeJsonSync(factoryPackagePath, factoryPackage, { spaces: 4 });
};

export const updateFiles = (plugins: Plugin[]) => {
    updateFactory(plugins);
    updatePackageJson(plugins);
};
