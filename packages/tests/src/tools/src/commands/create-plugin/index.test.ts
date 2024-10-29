// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getMirroredFixtures } from '@dd/tests/helpers/mocks';
import commands from '@dd/tools/commands/create-plugin/index';
import { ROOT } from '@dd/tools/constants';
import { Cli } from 'clipanion';

jest.mock('fs', () => require('memfs').fs);

describe('Command create-plugin', () => {
    const fixtures = getMirroredFixtures(
        ['.github/CODEOWNERS', `packages/plugins/telemetry/package.json`],
        ROOT,
    );
    const cli = new Cli();
    cli.register(commands[0]);

    beforeEach(() => {
        // Mock the files that are touched by yarn cli create-plugin.
        // FIXME: Using require here because clipanion + memfs somehow breaks memfs' singleton.
        require('memfs').vol.fromJSON(fixtures, ROOT);
    });

    afterEach(() => {
        require('memfs').vol.reset();
    });

    test('Should create the right files.', async () => {
        await cli.run([
            'create-plugin',
            '--name',
            'Testing #1',
            '--description',
            'Testing plugins a first time',
            '--codeowner',
            '@codeowners-1',
            '--codeowner',
            '@codeowners-2',
            '--type',
            'universal',
            '--hook',
            'enforce',
            '--hook',
            'buildStart',
            // --no-autofix to avoid running "yarn" and "yarn cli integrity"
            // which would run outside Jest's ecosystem.
            '--no-autofix',
        ]);

        const files = Object.fromEntries(
            Object.entries(require('memfs').vol.toJSON() as Record<string, string>).map(
                ([k, v]) => [k.replace(`${ROOT}/`, ''), v],
            ),
        );

        expect(Object.keys(files)).toEqual(
            expect.arrayContaining([
                'packages/plugins/testing-1/src/constants.ts',
                'packages/plugins/testing-1/src/index.ts',
                'packages/plugins/testing-1/src/types.ts',
                'packages/plugins/testing-1/package.json',
                'packages/plugins/testing-1/README.md',
                'packages/plugins/testing-1/tsconfig.json',
            ]),
        );

        expect(files['.github/CODEOWNERS']).toMatch(
            /packages\/plugins\/testing-1\s+@codeowners-1\s+@codeowners-2/,
        );
        expect(files['.github/CODEOWNERS']).toMatch(
            /packages\/tests\/src\/plugins\/testing-1\s+@codeowners-1\s+@codeowners-2/,
        );
    });
});
