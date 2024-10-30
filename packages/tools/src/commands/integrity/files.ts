// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputJsonSync, readJsonSync } from '@dd/core/helpers';
import {
    CONFIGS_KEY,
    HELPERS_KEY,
    IMPORTS_KEY,
    ROOT,
    TYPES_EXPORT_KEY,
    TYPES_KEY,
} from '@dd/tools/constants';
import {
    dim,
    getCamelCase,
    getPascalCase,
    getWorkspaces,
    green,
    red,
    replaceInBetween,
} from '@dd/tools/helpers';
import type { Workspace } from '@dd/tools/types';
import fs from 'fs';
import { outdent } from 'outdent';
import path from 'path';

const updateCore = (plugins: Workspace[]) => {
    const coreTypesPath = path.resolve(ROOT, 'packages/core/src/types.ts');
    let coreTypesContent = fs.readFileSync(coreTypesPath, 'utf-8');

    let importContent = '';
    let typeContent = '';

    plugins.forEach((plugin, i) => {
        console.log(`  Inject ${green(plugin.name)} into ${green('packages/core')}.`);

        const pascalCase = getPascalCase(plugin.slug);
        const camelCase = getCamelCase(plugin.slug);

        if (i > 0) {
            importContent += '\n';
            typeContent += '\n';
        }

        // Prepare content.
        importContent += outdent`
            import type { ${pascalCase}Options } from '${plugin.name}/types';
            import type * as ${camelCase} from '${plugin.name}';
        `;
        typeContent += `[${camelCase}.CONFIG_KEY]?: ${pascalCase}Options;`;
    });

    coreTypesContent = replaceInBetween(coreTypesContent, IMPORTS_KEY, importContent);
    coreTypesContent = replaceInBetween(coreTypesContent, TYPES_KEY, typeContent);

    // Write back to file.
    console.log(`  Write ${green('packages/core/src/types.ts')}.`);
    fs.writeFileSync(coreTypesPath, coreTypesContent, { encoding: 'utf-8' });
};

const updateFactory = async (plugins: Workspace[]) => {
    const factoryPath = path.resolve(ROOT, 'packages/factory/src/index.ts');
    let factoryContent = fs.readFileSync(factoryPath, 'utf-8');

    let importContent = '';
    let typesExportContent = '';
    let configContent = '';
    let helperContent = '';

    for (const plugin of plugins) {
        console.log(`  Inject ${green(plugin.name)} into ${green('packages/factory')}.`);
        const pluginExports = await import(plugin.name);

        const pascalCase = getPascalCase(plugin.slug);
        const camelCase = getCamelCase(plugin.slug);
        const configKeyVar = `${camelCase}.CONFIG_KEY`;

        // Prepare content.
        importContent += outdent`
            import type { OptionsWith${pascalCase} } from '${plugin.name}/types';
            import * as ${camelCase} from '${plugin.name}';
        `;
        typesExportContent += `export type { types as ${pascalCase}Types } from '${plugin.name}';`;
        configContent += outdent`
            if (options[${configKeyVar}] && options[${configKeyVar}].disabled !== true) {
                plugins.push(...${camelCase}.getPlugins(options as OptionsWith${pascalCase}, context));
            }
        `;

        // Only add helpers if they export them.
        if (pluginExports.helpers && Object.keys(pluginExports.helpers).length) {
            helperContent += `[${configKeyVar}]: ${camelCase}.helpers,`;
        }
    }

    // Update contents.
    factoryContent = replaceInBetween(factoryContent, IMPORTS_KEY, importContent);
    factoryContent = replaceInBetween(factoryContent, TYPES_EXPORT_KEY, typesExportContent);
    factoryContent = replaceInBetween(factoryContent, CONFIGS_KEY, configContent);
    factoryContent = replaceInBetween(factoryContent, HELPERS_KEY, helperContent);

    // Write back to file.
    console.log(`  Write ${green('packages/factory/src/index.ts')}.`);
    fs.writeFileSync(factoryPath, factoryContent, { encoding: 'utf-8' });
};

const updatePackageJson = (plugins: Workspace[]) => {
    const factoryPackagePath = path.resolve(ROOT, 'packages/factory/package.json');
    const factoryPackage = readJsonSync(factoryPackagePath);

    plugins.forEach((plugin) => {
        console.log(`  Add ${green(plugin.name)} dependency to ${green('packages/factory')}.`);
        factoryPackage.dependencies[plugin.name] = 'workspace:*';
    });

    console.log(`  Write ${green('packages/factory/package.json')}.`);
    outputJsonSync(factoryPackagePath, factoryPackage);
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
    await updateFactory(plugins);
    updateCore(plugins);
    updatePackageJson(plugins);
    errors.push(...verifyCodeowners(plugins));
    await updateBundlerPlugins(plugins);
    return errors;
};
