// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Command, Option } from 'clipanion';

class OSS extends Command {
    static paths = [['oss']];

    static usage = Command.Usage({
        category: `Verification`,
        description: `Runs a set of checks to confirm we follow our Open Source rules.`,
        details: `
            This command will do a few checks and fix what needs to be fixed:

            - Verify/Add the 3rd parties licenses.
            - Add the Open Source header on all the files.
            - Add/Update a NOTICE file.
            - Add/Update the LICENSE file.
        `,
        examples: [
            [`Use the wizard.`, `$0 oss`],
            [`Use a specific license.`, `$0 oss --license mit`],
            [
                `Target specific directories.`,
                `$0 oss --directories ./packages/core --directories ./packages/tools`,
            ],
        ],
    });

    license = Option.String(`-l,--license`, {
        description: 'Which license do you want? [mit, apache, bsd]',
    });
    directories = Option.Array(`-d,--directories`, {
        description: 'On which directories to add the Open Source header?',
    });
    name = 'build-plugin';

    async execute() {
        const { applyHeader, apply3rdPartiesLicenses, applyNotice, applyLicense } = await import(
            './apply'
        );
        await applyHeader(this.directories, this.license);
        console.log('Done header.');
        await apply3rdPartiesLicenses();
        console.log('Done 3rd parties licenses.');
        await applyNotice();
        console.log('Done notice.');
        await applyLicense(this.license);
        console.log('Done license.');
    }
}

export default [OSS];
