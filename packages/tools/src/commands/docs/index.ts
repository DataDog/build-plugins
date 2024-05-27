// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Command } from 'clipanion';
import fs from 'fs-extra';
import path from 'path';

import { ROOT, execute } from '../../helpers';

import { updateReadmes } from './readme';

export type Plugin = {
    name: string;
    location: string;
};

class Docs extends Command {
    static paths = [['docs']];

    static usage = Command.Usage({
        category: `Verification`,
        description: `Verify our documentations and files and update them.`,
        details: `
            This command will update our documentation to include all our plugins.
            And also some files to be sure we list all of our plugins.
        `,
        examples: [[`Update documentation`, `$0 docs`]],
    });

    async getPlugins() {
        const { stdout: rawPlugins } = await execute('yarn', ['workspaces', 'list', '--json']);
        // Replace new lines with commas to make it JSON valid.
        const jsonString = `[${rawPlugins.replace(/\n([^\]])/g, ',\n$1')}]`;
        const pluginsArray = JSON.parse(jsonString) as Plugin[];
        return pluginsArray.filter((plugin: Plugin) =>
            plugin.location.startsWith('packages/plugins'),
        );
    }

    async execute() {
        // Read the root README.md file.
        const rootReadmeContent = fs.readFileSync(path.resolve(ROOT, 'README.md'), 'utf-8');

        // Load all the plugins.
        const plugins = await this.getPlugins();

        const errors = [];

        errors.push(...(await updateReadmes(plugins, rootReadmeContent)));

        if (errors.length) {
            console.log(`\n${errors.join('\n')}`);
            throw new Error('Please fix the errors.');
        }
    }
}

export default [Docs];
