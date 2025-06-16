// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFileSync } from '@dd/core/helpers/fs';
import commands from '@dd/tools/commands/create-plugin/index';
import { Cli } from 'clipanion';

jest.mock('@dd/core/helpers/fs', () => {
    const original = jest.requireActual('@dd/core/helpers/fs');
    return {
        ...original,
        outputFileSync: jest.fn(),
    };
});

const mockOutputFileSync = jest.mocked(outputFileSync);

describe('Command create-plugin', () => {
    const cli = new Cli();
    cli.register(commands[0]);

    const cases = [
        {
            name: 'Universal Plugin',
            slug: 'universal',
            description: 'Testing universal plugins.',
            codeowners: ['@codeowners-1', '@codeowners-2'],
            type: 'universal',
            hooks: ['enforce', 'buildStart'],
        },
        {
            name: 'Bundler Plugin',
            slug: 'bundler',
            description: 'Testing bundler plugins.',
            codeowners: ['@codeowners-1', '@codeowners-2'],
            type: 'bundler',
            hooks: ['webpack', 'esbuild'],
        },
        {
            name: 'Internal Plugin',
            slug: 'internal',
            description: 'Testing internal plugins.',
            codeowners: ['@codeowners-1', '@codeowners-2'],
            type: 'internal',
            hooks: ['webpack', 'esbuild', 'enforce', 'buildStart'],
        },
    ];

    describe.each(cases)('$name', ({ name, slug, description, codeowners, type, hooks }) => {
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
        });

        test('Should create the right files.', async () => {
            const expectedFiles = [
                `packages/plugins/${slug}/src/constants.ts`,
                `packages/plugins/${slug}/src/index.ts`,
                `packages/plugins/${slug}/package.json`,
                `packages/plugins/${slug}/README.md`,
                `packages/plugins/${slug}/tsconfig.json`,
                `.github/CODEOWNERS`,
            ];

            if (type !== 'internal') {
                // We don't create types and tests files for internal plugins.
                expectedFiles.push(
                    `packages/plugins/${slug}/src/types.ts`,
                    `packages/plugins/${slug}/src/index.test.ts`,
                );
            }

            expect(mockOutputFileSync).toHaveBeenCalledTimes(expectedFiles.length);
            for (const file of expectedFiles) {
                expect(mockOutputFileSync).toHaveBeenCalledWith(
                    expect.stringContaining(file),
                    expect.any(String),
                );
            }
        });

        test('Should add the right CODEOWNERS', () => {
            // Matches the files lines in CODEOWNERS.
            const fileRx = new RegExp(
                `packages\\/plugins\\/${slug}${codeowners.map((c) => `\\s+${c}`).join('')}`,
            );

            // Get the call on the CODEOWNERS file.
            const fnCall = mockOutputFileSync.mock.calls.find((call) =>
                call[0].endsWith('.github/CODEOWNERS'),
            );

            expect(fnCall).toBeDefined();
            expect(fnCall![1]).toMatch(fileRx);
        });
    });
});
