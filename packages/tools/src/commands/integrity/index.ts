// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Command, Option } from 'clipanion';

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

    noFailure = Option.Boolean('--no-failure', {
        description: 'Will run everything without throwing.',
    });

    async execute() {
        const { runAutoFixes } = await import('@dd/tools/helpers');
        const { updateDependencies } = await import('./dependencies');
        const { updateFiles } = await import('./files');
        const { updateReadmes, injectTocsInAllReadmes } = await import('./readme');
        const { getWorkspaces } = await import('@dd/tools/helpers');

        const workspaces = await getWorkspaces();

        // Load all the plugins.
        const plugins = workspaces.filter((workspace) =>
            workspace.location.startsWith('packages/plugins'),
        );

        const bundlers = workspaces.filter((workspace) =>
            workspace.name.match(/^@datadog\/.*-plugin$/),
        );

        const errors: string[] = [];

        // Verify that our published package list the right dependencies from the internals.
        errors.push(...(await updateDependencies(workspaces, bundlers)));
        // Check if all README.md files exist and are correct.
        errors.push(...(await updateReadmes(plugins, bundlers)));
        // Inject TOC into all of the readmes.
        injectTocsInAllReadmes();
        // Update the files that need to be updated.
        errors.push(...(await updateFiles(plugins)));
        // Run auto-fixes to ensure the code is correct.
        errors.push(...(await runAutoFixes()));

        if (errors.length) {
            console.log(`\n${errors.join('\n')}`);

            if (!this.noFailure) {
                const error = new Error('Please fix the above errors.');
                // No need to display a stack trace here.
                error.stack = '';
                throw error;
            }
        }
    }
}

export default [Integrity];
