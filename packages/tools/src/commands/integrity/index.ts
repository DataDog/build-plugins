// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Command } from 'clipanion';

import type { Plugin } from '../../types';

type SlugLessPlugin = Omit<Plugin, 'slug'>;

class Integrity extends Command {
    static paths = [['integrity']];

    static usage = Command.Usage({
        category: `Verification`,
        description: `Verify our documentations and files integrity.`,
        details: `
            This command will update our documentation to include all of our plugins.
            And also some files to be sure we list all of our plugins everywhere that's needed.
        `,
        examples: [[`Run integrity check and update`, `$0 integrity`]],
    });

    async getPlugins() {
        const { execute } = await import('../../helpers');
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
        const { runAutoFixes } = await import('../../helpers');
        const { updateFiles } = await import('./files');
        const { updateReadmes } = await import('./readme');

        // Load all the plugins.
        const plugins = await this.getPlugins();

        const errors: string[] = [];

        // Check if all README.md files exist and are correct.
        errors.push(...(await updateReadmes(plugins)));
        // Update the files that need to be updated.
        updateFiles(plugins);
        // Run auto-fixes to ensure the code is correct.
        await runAutoFixes();

        if (errors.length) {
            console.log(`\n${errors.join('\n')}`);
        }
    }
}

export default [Integrity];
