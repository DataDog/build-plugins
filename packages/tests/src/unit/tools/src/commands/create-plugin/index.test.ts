// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getMirroredFixtures } from '@dd/tests/_jest/helpers/mocks';
import commands from '@dd/tools/commands/create-plugin/index';
import { ROOT } from '@dd/tools/constants';
import { Cli } from 'clipanion';
import { vol } from 'memfs';

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
        vol.fromJSON(fixtures, ROOT);
    });

    afterEach(() => {
        vol.reset();
    });

    const cases = [
        {
            name: 'Universal Plugin',
            slug: 'universal-plugin',
            description: 'Testing universal plugins.',
            codeowners: ['@codeowners-1', '@codeowners-2'],
            type: 'universal',
            hooks: ['enforce', 'buildStart'],
        },
        {
            name: 'Bundler Plugin',
            slug: 'bundler-plugin',
            description: 'Testing bundler plugins.',
            codeowners: ['@codeowners-1', '@codeowners-2'],
            type: 'bundler',
            hooks: ['webpack', 'esbuild'],
        },
        {
            name: 'Internal Plugin',
            slug: 'internal-plugin',
            description: 'Testing internal plugins.',
            codeowners: ['@codeowners-1', '@codeowners-2'],
            type: 'internal',
            hooks: ['webpack', 'esbuild', 'enforce', 'buildStart'],
        },
    ];

    describe.each(cases)('$name', ({ name, slug, description, codeowners, type, hooks }) => {
        let files: Record<string, string>;
        beforeEach(async () => {
            const options = [
                'create-plugin',
                '--name',
                name,
                '--description',
                description,
                '--type',
                type,
                ...codeowners.flatMap((codeowner) => ['--codeowner', codeowner]),
                ...hooks.flatMap((hook) => ['--hook', hook]),
            ];

            await cli.run([
                ...options,
                // --no-autofix to avoid running "yarn" and "yarn cli integrity"
                // which would run outside Jest's ecosystem.
                '--no-autofix',
            ]);

            files = Object.fromEntries(
                Object.entries(require('memfs').vol.toJSON() as Record<string, string>).map(
                    ([k, v]) => [k.replace(`${ROOT}/`, ''), v],
                ),
            );
        });

        test('Should create the right files.', async () => {
            const expectedFiles = [
                `packages/plugins/${slug}/src/constants.ts`,
                `packages/plugins/${slug}/src/index.ts`,
                `packages/plugins/${slug}/package.json`,
                `packages/plugins/${slug}/README.md`,
            ];

            if (type !== 'internal') {
                // We don't create a types file for internal plugins.
                expectedFiles.push(`packages/plugins/${slug}/src/types.ts`);
            }

            expect(Object.keys(files)).toEqual(expect.arrayContaining(expectedFiles));
        });

        test('Should add the right CODEOWNERS', () => {
            // Matches the files lines in CODEOWNERS.
            const fileRx = new RegExp(
                `packages\\/plugins\\/${slug}${codeowners.map((c) => `\\s+${c}`).join('')}`,
            );
            // Matches the tests lines in CODEOWNERS.
            const testRx = new RegExp(
                `packages\\/tests\\/src\\/plugins\\/${slug}${codeowners.map((c) => `\\s+${c}`).join('')}`,
            );

            expect(files['.github/CODEOWNERS']).toMatch(fileRx);
            expect(files['.github/CODEOWNERS']).toMatch(testRx);
        });
    });
});
