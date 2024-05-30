// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs-extra';
import { outdent } from 'outdent';
import path from 'path';

import {
    CONFIGS_KEY,
    HELPERS_KEY,
    IMPORTS_KEY,
    ROOT,
    TYPES_EXPORT_KEY,
    TYPES_KEY,
} from '../../constants';
import {
    dim,
    getCamelCase,
    getPascalCase,
    getUpperCase,
    getWorkspaces,
    green,
    red,
    replaceInBetween,
} from '../../helpers';
import type { Workspace } from '../../types';

const updateFactory = (plugins: Workspace[]) => {
    const factoryPath = path.resolve(ROOT, 'packages/factory/src/index.ts');
    let factoryContent = fs.readFileSync(factoryPath, 'utf-8');

    let importContent = '';
    let typeContent = '';
    let typesExportContent = '';
    let configContent = '';
    let helperContent = '';

    plugins.forEach((plugin, i) => {
        console.log(`  Inject ${green(plugin.name)} into ${green('packages/factory')}.`);

        const pascalCase = getPascalCase(plugin.slug);
        const camelCase = getCamelCase(plugin.slug);
        const upperCase = getUpperCase(plugin.slug);

        if (i > 0) {
            importContent += '\n';
            typeContent += '\n';
            typesExportContent += '\n';
            configContent += '\n';
            helperContent += '\n';
        }

        // Prepare content.
        importContent += outdent`
            import type { OptionsWith${pascalCase}Enabled, ${pascalCase}Options } from '${plugin.name}/types';
            import {
                helpers as ${camelCase}Helpers,
                getPlugins as get${pascalCase}Plugins,
                CONFIG_KEY as ${upperCase}_CONFIG_KEY,
            } from '${plugin.name}';
        `;
        typeContent += `[${upperCase}_CONFIG_KEY]?: ${pascalCase}Options;`;
        typesExportContent += `export type { types as ${pascalCase}Types } from '${plugin.name}';`;
        configContent += outdent`
            if (options[${upperCase}_CONFIG_KEY] && options[${upperCase}_CONFIG_KEY].disabled !== true) {
                plugins.push(...get${pascalCase}Plugins(options as OptionsWith${pascalCase}Enabled));
            }
        `;
        helperContent += `[${upperCase}_CONFIG_KEY]: ${camelCase}Helpers,`;
    });

    // Update contents.
    factoryContent = replaceInBetween(factoryContent, IMPORTS_KEY, importContent);
    factoryContent = replaceInBetween(factoryContent, TYPES_KEY, typeContent);
    factoryContent = replaceInBetween(factoryContent, TYPES_EXPORT_KEY, typesExportContent);
    factoryContent = replaceInBetween(factoryContent, CONFIGS_KEY, configContent);
    factoryContent = replaceInBetween(factoryContent, HELPERS_KEY, helperContent);

    // Write back to file.
    console.log(`  Write ${green('packages/factory/src/index.ts')}.`);
    fs.writeFileSync(factoryPath, factoryContent, { encoding: 'utf-8' });
};

const updatePackageJson = (plugins: Workspace[]) => {
    const factoryPackagePath = path.resolve(ROOT, 'packages/factory/package.json');
    const factoryPackage = fs.readJsonSync(factoryPackagePath);

    plugins.forEach((plugin) => {
        console.log(`  Add ${green(plugin.name)} dependency to ${green('packages/factory')}.`);
        factoryPackage.dependencies[plugin.name] = 'workspace:*';
    });

    console.log(`  Write ${green('packages/factory/package.json')}.`);
    fs.writeJsonSync(factoryPackagePath, factoryPackage, { spaces: 4 });
};

const updateBundlerPlugins = async (plugins: Workspace[]) => {
    const publishedPackages = await getWorkspaces((workspace) =>
        workspace.name.startsWith('@datadog/'),
    );

    let exportTypesContent = '';
    plugins.forEach((plugin, i) => {
        console.log(`  Inject ${green(plugin.name)}'s types into our published packages.`);
        exportTypesContent += `${getPascalCase(plugin.slug)}Types,`;
    });

    for (const pkg of publishedPackages) {
        const packagePath = path.resolve(ROOT, pkg.location, 'src/index.ts');
        if (!fs.existsSync(packagePath)) {
            continue;
        }
        let packageContent = fs.readFileSync(packagePath, 'utf-8');
        packageContent = replaceInBetween(packageContent, TYPES_EXPORT_KEY, exportTypesContent);
        console.log(`  Write ${green(`${pkg.location}/src/index.ts`)}.`);
        fs.writeFileSync(packagePath, packageContent, { encoding: 'utf-8' });
    }
};

const verifyCodeowners = (plugins: Workspace[]) => {
    const errors: string[] = [];
    const error = red('Error');
    const codeownersPath = '.github/CODEOWNERS';
    const codeownersFullPath = path.resolve(ROOT, codeownersPath);
    const codeowners = fs.readFileSync(codeownersFullPath, 'utf-8');

    for (const plugin of plugins) {
        const title = green(plugin.slug);
        console.log(`  Verifying ${title} is in ${green(codeownersPath)}.`);
        const testsPath = `packages/tests/src/plugins/${plugin.slug}`;
        const pluginPath = `${plugin.location}`;

        if (!codeowners.includes(testsPath)) {
            errors.push(
                `[${error}] Missing ${title}'s tests (${dim(testsPath)}) in ${green(codeownersPath)}.`,
            );
        }

        if (!codeowners.includes(pluginPath)) {
            errors.push(
                `[${error}] Missing ${title} (${dim(pluginPath)}) in ${green(codeownersPath)}.`,
            );
        }
    }

    return errors;
};

export const updateFiles = async (plugins: Workspace[]) => {
    const errors: string[] = [];
    updateFactory(plugins);
    updatePackageJson(plugins);
    errors.push(...verifyCodeowners(plugins));
    await updateBundlerPlugins(plugins);
    return errors;
};
