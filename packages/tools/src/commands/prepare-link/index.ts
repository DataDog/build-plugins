// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Command, Option } from 'clipanion';
import fs from 'fs';
import path from 'path';

class PrepareLink extends Command {
    static paths = [['prepare-link']];

    static usage = Command.Usage({
        category: `Contribution`,
        description: `Prepare our published packages to be linked from another project.`,
        details: `
            This command will change the package.json values of "exports" so they can be used from another project.

            This is necessary to be sure that the outside project loads the built files and not the dev files.
        `,
        examples: [
            [`Prepare for link`, `$0 prepare-link`],
            [`Revert change`, `$0 prepare-link --revert`],
        ],
    });

    revert = Option.Boolean('--revert', {
        description: 'Revert the changes.',
    });

    async execute() {
        const { getWorkspaces, green, red } = await import('@dd/tools/helpers');
        const { ROOT } = await import('@dd/tools/constants');

        const workspaces = await getWorkspaces();

        // Only get the published packages.
        const publishedPackages = workspaces.filter((workspace) =>
            workspace.name.match(/^@datadog\/.*-plugin$/),
        );

        try {
            for (const pkg of publishedPackages) {
                const pkgJsonPath = path.resolve(ROOT, pkg.location, 'package.json');
                const pkgJson = require(pkgJsonPath);
                if (this.revert) {
                    pkgJson.exports = {
                        './dist/src': './dist/src/index.js',
                        './dist/src/*': './dist/src/*',
                        '.': './src/index.ts',
                    };
                } else {
                    pkgJson.exports = pkgJson.publishConfig.exports;
                }

                fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 4)}\n`);
            }

            console.log(
                green(
                    `All packages have been ${this.revert ? 'restored from linking.' : 'prepared for linking.'}`,
                ),
            );
        } catch (error: any) {
            console.error(red(error));
        }
    }
}

export default [PrepareLink];
