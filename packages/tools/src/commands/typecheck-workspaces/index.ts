// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Command, Option } from 'clipanion';

class TypecheckWorkspace extends Command {
    static paths = [['typecheck-workspaces']];

    static usage = Command.Usage({
        category: `Verification`,
        description: `Typecheck workspaces of files given.`,
        details: `
            This command will typecheck only the workspaces of the files passed as arguments.

            This is mostly useful for our Git pre-commit hook, to reduce the duration of the typecheck.
        `,
        examples: [
            [`Typecheck @dd/core`, `$0 typecheck-workspaces --files packages/core/src/index.ts`],
        ],
    });

    files = Option.Array('--files', {
        description: 'Files to typecheck.',
    });

    async execute() {
        const { getClosestPackageJson } = await import('@dd/core/helpers/paths');
        const { execute } = await import('../../helpers');
        const files: string[] = this.files || [];
        const packageJsons = new Set<string>(
            files.map((file) => getClosestPackageJson(file)).filter(Boolean) as string[],
        );

        // Get the names of each workspace from their package.json.
        const workspacesToTypecheck = (
            await Promise.all(
                Array.from(packageJsons).map(async (packageJson) => {
                    const { name, scripts } = await import(packageJson);
                    // Only use worksapces that have a typecheck script.
                    if (scripts?.typecheck) {
                        return name;
                    }
                }),
            )
        ).filter(Boolean) as string[];

        // Run the typecheck command for each workspace.
        if (workspacesToTypecheck.length) {
            console.log(`Typechecking workspaces:\n  - ${workspacesToTypecheck.join('\n  - ')}`);
            await execute(`yarn`, [
                'workspaces',
                'foreach',
                '-A',
                ...workspacesToTypecheck.map((workspace) => `--include=${workspace}`),
                'run',
                'typecheck',
            ]);
        } else {
            console.log(`No workspaces to typecheck.`);
        }
    }
}

export default [TypecheckWorkspace];
