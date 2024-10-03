// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import commands from '@dd/tools/commands/create-plugin/index';
import { ROOT } from '@dd/tools/constants';
import { Cli } from 'clipanion';
import fs from 'fs';
import path from 'path';

jest.mock('fs', () => jest.requireActual('memfs').fs);

const getMirroredFixtures = (paths: string[], cwd: string) => {
    const fsa = jest.requireActual('fs');
    const fixtures: Record<string, string> = {};
    for (const p of paths) {
        fixtures[p] = fsa.readFileSync(path.resolve(cwd, p), 'utf-8');
    }
    return fixtures;
};

const getArgs = (opts: {
    name?: string;
    description?: string;
    codeowners?: string[];
    type?: string;
    hooks?: string[];
}) => {
    const args: string[] = [];
    if (opts.name) {
        args.push('--name', opts.name);
    }
    if (opts.description) {
        args.push('--description', opts.description);
    }
    if (opts.codeowners) {
        args.push(...opts.codeowners.map((co) => ['--codeowner', co]).flat());
    }
    if (opts.type) {
        args.push('--type', opts.type);
    }
    if (opts.hooks) {
        args.push(...opts.hooks.map((h) => ['--hook', h]).flat());
    }
    return args;
};

describe('Command create-plugin', () => {
    const fixtures = getMirroredFixtures(
        ['.github/CODEOWNERS', `packages/plugins/telemetry/package.json`],
        ROOT,
    );
    console.log('FIXTURES', Object.keys(fixtures));
    beforeEach(() => {
        // Mock the files that are touched by yarn cli create-plugin and yarn cli integrity.
        require('memfs').vol.fromJSON(fixtures, ROOT);
        console.log(ROOT);
    });

    afterEach(() => {});

    test('It should create a plugin.', async () => {
        console.log(
            require('memfs').readdirSync(
                `/Users/mael.nison/go/src/github.com/DataDog/build-plugin`,
            ),
        );
        const cli = new Cli();
        cli.register(commands[0]);

        const args = getArgs({
            name: 'Testing #1',
            description: 'Testing plugin',
            codeowners: ['@codeowners'],
            type: 'universal',
            hooks: ['enforce'],
        });
        const result = await cli.run(['create-plugin', ...args]);
        console.log('TEST', fs.readdirSync(ROOT));
        console.log(result);
        // console.log(Object.keys(vol.toJSON()).map((k) => k.replace(ROOT, '.')));
    });
});
