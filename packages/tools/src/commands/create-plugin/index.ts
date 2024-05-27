// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import checkbox from '@inquirer/checkbox';
import input from '@inquirer/input';
import { Command, Option } from 'clipanion';
import fs from 'fs-extra';
import path from 'path';

import { ROOT } from '../../constants';
import { green, slugify, runAutoFixes } from '../../helpers';
import type { Context, Plugin } from '../../types';
import { updateFiles } from '../integrity/files';
import { updateReadmes } from '../integrity/readme';

import { getFiles } from './templates';

class CreatePlugin extends Command {
    static paths = [['create-plugin']];

    static usage = Command.Usage({
        category: `Contribution`,
        description: `Bootstrap your new plugin with all the necessary files.`,
        details: `
            This command will help you create the files you need to follow the best practices of this repository.

            You will be able to pick which type of plugin you want to build and which type of files you want to include.
        `,
        examples: [
            [`Use the full wizard`, `$0 create-plugin`],
            [`Pass a name directly`, `$0 create-plugin --name "Error Tracking"`],
            [
                `Pass a name, make it for webpack and esbuild, and include the test files.`,
                `$0 create-plugin --name "Error Tracking" --webpack --esbuild --tests`,
            ],
        ],
    });

    name = Option.String('--name', { description: 'Name of the plugin to create.' });
    webpack = Option.Boolean('--webpack', { description: 'Include webpack specifics.' });
    esbuild = Option.Boolean('--esbuild', { description: 'Include esbuild specifics.' });
    tests = Option.Boolean('--tests', { description: 'Include test files.' });

    async askName() {
        let slug;

        if (this.name) {
            slug = slugify(this.name);
        } else {
            const name = await input({ message: 'Enter the name of your plugin:' });
            slug = slugify(name);
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

    async execute() {
        const name = await this.askName();
        const filesToInclude = await this.askFilesToInclude();
        const plugin: Plugin = {
            name: `@dd/${name}-plugins`,
            slug: name,
            location: `packages/plugins/${name}`,
        };
        const context: Context = {
            plugin,
            tests: filesToInclude.includes('tests'),
            webpack: filesToInclude.includes('webpack'),
            esbuild: filesToInclude.includes('esbuild'),
        };

        // Create all the necessary files.
        await this.createFiles(context);

        // Update our documentations.
        await updateReadmes([plugin]);

        // Update the shared files.
        updateFiles([plugin]);

        // Run all the autofixes.
        await runAutoFixes();
    }
}

export default [CreatePlugin];
