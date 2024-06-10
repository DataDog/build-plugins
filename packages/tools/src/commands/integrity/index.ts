// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Command } from 'clipanion';

import { getWorkspaces } from '../../helpers';

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

    async execute() {
        const { runAutoFixes } = await import('../../helpers');
        const { updateFiles } = await import('./files');
        const { updateReadmes, injectTocsInAllReadmes } = await import('./readme');

        // Load all the plugins.
        const plugins = await getWorkspaces((workspace) =>
            workspace.location.startsWith('packages/plugins'),
        );

        const errors: string[] = [];

        // Check if all README.md files exist and are correct.
        errors.push(...(await updateReadmes(plugins)));
        // Inject TOC into all of the readmes.
        injectTocsInAllReadmes();
        // Update the files that need to be updated.
        errors.push(...(await updateFiles(plugins)));
        // Run auto-fixes to ensure the code is correct.
        await runAutoFixes();

        if (errors.length) {
            console.log(`\n${errors.join('\n')}`);
            throw new Error('Please fix the errors.');
        }
    }
}

export default [Integrity];
