// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import chalk from 'chalk';
import { execFileSync } from 'child_process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'child_process';
import path from 'path';

import { getEnv, logEnv, setupEnv } from './helpers/env';

const c = chalk.bold.dim;

const setupGit = (execOptions: ExecFileSyncOptionsWithStringEncoding) => {
    const setupSteps: { name: string; commands: string[]; fallbacks?: string[] }[] = [
        {
            // Initialize a git repository.
            name: 'Init',
            commands: ['git init'],
        },
        {
            // Ensure we have a local user.
            name: 'Git user',
            commands: ['git config --local user.email'],
            fallbacks: [
                'git config --local user.email fake@example.com',
                'git config --local user.name fakeuser',
            ],
        },
        {
            // Ensure origin exists
            name: 'Origin',
            commands: ['git ls-remote --get-url'],
            fallbacks: ['git remote add origin fake_origin'],
        },
        {
            // Ensure HEAD exists
            name: 'HEAD',
            commands: ['git rev-parse --verify HEAD'],
            // Fake HEAD.
            fallbacks: ['git commit --allow-empty -n -m "abc"'],
        },
    ];

    const runCmds = (commands: string[]) => {
        for (const command of commands) {
            const args = command.split(' ');
            execFileSync(args[0], args.slice(1), execOptions);
        }
    };
    for (const { name, commands, fallbacks } of setupSteps) {
        try {
            runCmds(commands);
        } catch (e) {
            if (!fallbacks || fallbacks.length === 0) {
                throw e;
            }
            console.log(c.yellow(`  - ${name} does not exist, creating it.`));
            runCmds(fallbacks);
        }
    }
};

const globalSetup = () => {
    const timeId = `[${c.cyan('Test environment setup duration')}]`;
    console.time(timeId);
    const env = getEnv(process.argv);
    // Setup the environment.
    setupEnv(env);
    // Log some tips to the console.
    logEnv(env);

    // Setup fixtures.
    const execOptions: ExecFileSyncOptionsWithStringEncoding = {
        cwd: path.resolve(__dirname, './fixtures'),
        encoding: 'utf-8',
        stdio: [],
    };

    try {
        // Install dependencies.
        execFileSync('yarn', ['install'], execOptions);
        setupGit(execOptions);
    } catch (e) {
        console.error('Fixtures setup failed:', e);
    }
    console.timeEnd(timeId);
};

export default globalSetup;
