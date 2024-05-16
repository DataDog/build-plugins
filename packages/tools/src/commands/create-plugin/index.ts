// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import checkbox from '@inquirer/checkbox';
import input from '@inquirer/input';
import { Command, Option } from 'clipanion';
import fs from 'fs-extra';
import outdent from 'outdent';
import path from 'path';

import {
    ROOT,
    green,
    execute,
    injectIntoString,
    IMPORTS_KEY,
    TYPES_KEY,
    CONFIGS_KEY,
} from '../../helpers';

import { getFiles, getPascalCase, getUpperCase, type Context } from './templates';

class Dashboard extends Command {
    static paths = [['create-plugin']];

    name = Option.String('--name', { description: 'Name of the plugin to create.' });
    webpack = Option.Boolean('--webpack', { description: 'Include webpack specifics.' });
    esbuild = Option.Boolean('--esbuild', { description: 'Include esbuild specifics.' });
    tests = Option.Boolean('--tests', { description: 'Include test files.' });

    slugify(string: string) {
        return string
            .toString()
            .normalize('NFD') // Split an accented letter in the base letter and the acent
            .replace(/[\u0300-\u036f]/g, '') // Remove all previously split accents
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9 ]/g, '') // Remove all chars not letters, numbers and spaces
            .replace(/\s+/g, '-'); // Collapse whitespace and replace by -
    }

    async askName() {
        let slug;

        if (this.name) {
            slug = this.slugify(this.name);
        } else {
            const name = await input({ message: 'Enter the name of your plugin:' });
            slug = this.slugify(name);
        }

        console.log(`Will use ${green(slug)} as the plugin's name.`);
        return slug;
    }

    async askFilesToInclude() {
        if (this.webpack || this.esbuild || this.tests) {
            const files = [];
            if (this.tests) {
                files.push('tests');
            }
            if (this.webpack) {
                files.push('webpack');
            }
            if (this.esbuild) {
                files.push('esbuild');
            }
            return files;
        }
        return checkbox({
            message: 'Select what you want to include:',
            choices: [
                { name: 'Test files', value: 'tests', checked: true },
                { name: 'Webpack specifics', value: 'webpack', checked: false },
                { name: 'ESBuild specifics', value: 'esbuild', checked: false },
            ],
        });
    }

    async createFiles(context: Context) {
        const filesToCreate = getFiles(context);
        for (const file of filesToCreate) {
            console.log(`Creating ${green(file.name)}.`);
            fs.outputFileSync(path.resolve(ROOT, file.name), file.content(context));
        }
    }

    async updateFiles(context: Context) {
        // Inject new plugin infos in packages/factory/src/index.ts.
        console.log(`Updating ${green('packages/factory/src/index.ts')}.`);
        const factoryPath = path.resolve(ROOT, 'packages/factory/src/index.ts');
        let factoryContent = fs.readFileSync(factoryPath, 'utf-8');
        const pascalCase = getPascalCase(context.name);
        const upperCase = getUpperCase(context.name);

        // Prepare content.
        const newImportContent = outdent`
            import type { OptionsWith${pascalCase}Enabled, ${pascalCase}Options } from '@dd/${context.name}-plugins/types';
            import{
                getPlugins as get${pascalCase}Plugins,
                CONFIG_KEY as ${upperCase}_CONFIG_KEY,
            } from '@dd/${context.name}-plugins';
        `;
        const newTypeContent = `[${upperCase}_CONFIG_KEY]?: ${pascalCase}Options,`;
        const newConfigContent = outdent`
            if (options[${upperCase}_CONFIG_KEY] && options[${upperCase}_CONFIG_KEY].disabled !== true) {
                plugins.push(...get${pascalCase}Plugins(options as OptionsWith${pascalCase}Enabled));
            }
        `;

        // Update contents.
        factoryContent = injectIntoString(factoryContent, IMPORTS_KEY, newImportContent);
        factoryContent = injectIntoString(factoryContent, TYPES_KEY, newTypeContent);
        factoryContent = injectIntoString(factoryContent, CONFIGS_KEY, newConfigContent);

        // Write back to file.
        fs.writeFileSync(factoryPath, factoryContent, { encoding: 'utf-8' });

        // Add dependency on @dd/${context.name}-plugins in packages/factory.
        console.log(
            `Add ${green(`@dd/${context.name}`)} dependency to ${green('packages/factory')}.`,
        );
        const factoryPackagePath = path.resolve(ROOT, 'packages/factory/package.json');
        const factoryPackage = fs.readJsonSync(factoryPackagePath);
        factoryPackage.dependencies[`@dd/${context.name}-plugins`] = 'workspace:*';
        fs.writeJsonSync(factoryPackagePath, factoryPackage, { spaces: 4 });

        // Run yarn to update lockfiles.
        console.log(`Running ${green('yarn')}.`);
        await execute('yarn', [], ROOT);

        // Run yarn format to ensure all files are well formated.
        console.log(`Running ${green('yarn format')}.`);
        await execute('yarn', ['format'], ROOT);

        // Run yarn oss to update headers and licenses if necessary.
        console.log(`Running ${green('yarn oss')}.`);
        await execute('yarn', ['oss'], ROOT);
    }

    async execute() {
        const name = await this.askName();
        const filesToInclude = await this.askFilesToInclude();
        const context: Context = {
            name,
            tests: filesToInclude.includes('tests'),
            webpack: filesToInclude.includes('webpack'),
            esbuild: filesToInclude.includes('esbuild'),
        };
        await this.createFiles(context);
        await this.updateFiles(context);
    }
}

export default [Dashboard];