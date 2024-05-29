// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Command, Option } from 'clipanion';
import path from 'path';

import type { Context, Workspace } from '../../types';

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

    async createFiles(context: Context) {
        const fs = await import('fs-extra');
        const { getFiles } = await import('./templates');
        const { ROOT } = await import('../../constants');
        const { green } = await import('../../helpers');

        const filesToCreate = getFiles(context);
        for (const file of filesToCreate) {
            console.log(`Creating ${green(file.name)}.`);
            fs.outputFileSync(path.resolve(ROOT, file.name), file.content(context));
        }
    }

    async execute() {
        const { askName, askFilesToInclude } = await import('./ask');
        const { execute, green } = await import('../../helpers');

        const name = await askName(this.name);
        const filesToInclude = await askFilesToInclude({
            webpack: this.webpack,
            esbuild: this.esbuild,
            tests: this.tests,
        });

        const plugin: Workspace = {
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

        // Run the integrity check.
        console.log(`Running ${green('yarn cli integrity')}.`);
        await execute('yarn', ['cli', 'integrity']);
    }
}

export default [CreatePlugin];
