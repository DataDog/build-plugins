// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Command } from 'clipanion';

import { execute, runAutoFixes } from '../../helpers';
import type { Plugin } from '../../types';

import { updateFiles } from './files';
import { updateReadmes } from './readme';

type SlugLessPlugin = Omit<Plugin, 'slug'>;

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
        const pluginsArray = JSON.parse(jsonString) as SlugLessPlugin[];
        return pluginsArray
            .filter((plugin: SlugLessPlugin) => plugin.location.startsWith('packages/plugins'))
            .map((plugin: SlugLessPlugin) => ({
                ...plugin,
                slug: plugin.location.split('/').pop() as string,
            }));
    }

    async execute() {
        // Load all the plugins.
        const plugins = await this.getPlugins();

        const errors = [];
        console.log(plugins);
        errors.push(...(await updateReadmes(plugins)));
        updateFiles(plugins);
        await runAutoFixes();

        if (errors.length) {
            console.log(`\n${errors.join('\n')}`);
            throw new Error('Please fix the errors.');
        }
    }
}

export default [Docs];
