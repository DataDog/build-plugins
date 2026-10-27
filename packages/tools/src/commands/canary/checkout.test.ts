// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, outputFile, rm } from '@dd/core/helpers/fs';
import os from 'os';
import path from 'path';

import { checkoutTarget, getCheckoutRef, getGitAuthEnvironment } from './checkout';
import type { CommandSpec, RunCommand, TargetRepository } from './types';

const TEST_ROOT = path.resolve(os.tmpdir(), `build-plugins-canary-checkout-${process.pid}`);
const CHECKOUT_ROOT = path.resolve(TEST_ROOT, 'checkout');
const REPOSITORY: TargetRepository = {
    name: 'example/app',
    branch: 'main',
};
const TOKEN = 'ghs_secret-token';

describe('canary checkout', () => {
    beforeEach(async () => {
        await rm(TEST_ROOT);
    });

    afterAll(async () => {
        await rm(TEST_ROOT);
    });

    const refCases = [
        {
            description: 'use the tracked branch',
            repository: REPOSITORY,
            override: undefined,
            expected: 'main',
        },
        {
            description: 'prefer a temporary pin over the branch',
            repository: { ...REPOSITORY, pin: { commit: 'abc123', reason: 'Upstream is broken.' } },
            override: undefined,
            expected: 'abc123',
        },
        {
            description: 'prefer a manual override over a pin',
            repository: { ...REPOSITORY, pin: { commit: 'abc123', reason: 'Upstream is broken.' } },
            override: 'release',
            expected: 'release',
        },
    ];

    test.each(refCases)('should $description', ({ repository, override, expected }) => {
        const ref = getCheckoutRef(repository, override);

        expect(ref).toBe(expected);
    });

    test('should pass no git configuration without a token', () => {
        const environment = getGitAuthEnvironment(undefined);

        expect(environment).toEqual({});
    });

    test('should fetch one commit, retry a failed fetch, and keep the token out of commands', async () => {
        const specs: CommandSpec[] = [];
        let fetchAttempts = 0;
        const runCommand: RunCommand = async (spec) => {
            specs.push(spec);
            const isFetch = spec.args[0] === 'fetch';
            if (isFetch) {
                fetchAttempts += 1;
            }
            const failed = isFetch && fetchAttempts === 1;
            const output = spec.args[0] === 'rev-parse' ? '0123abcd\n' : '';
            return { durationMs: 1, exitCode: failed ? 128 : 0, output, signal: null };
        };

        const commit = await checkoutTarget({
            networkRetryDelaysMs: [0, 0],
            ref: 'main',
            repository: REPOSITORY,
            root: CHECKOUT_ROOT,
            runCommand,
            token: TOKEN,
        });

        expect(commit).toBe('0123abcd');
        expect(existsSync(CHECKOUT_ROOT)).toBe(true);
        const commands = specs.map((spec) => spec.args.join(' '));
        expect(commands).toEqual([
            'init --quiet',
            'remote add origin https://github.com/example/app.git',
            'fetch --depth 1 --no-tags origin main',
            'fetch --depth 1 --no-tags origin main',
            'checkout --quiet --detach FETCH_HEAD',
            'rev-parse HEAD',
        ]);
        const fetchEnvironment = specs[2]?.env ?? {};
        const credentials = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
        expect(fetchEnvironment.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${credentials}`);
        const serializedSpecs = JSON.stringify(specs);
        expect(serializedSpecs).not.toContain(TOKEN);
        const otherEnvironments = specs.filter((spec) => spec.args[0] !== 'fetch');
        expect(otherEnvironments.every((spec) => !spec.env?.GIT_CONFIG_COUNT)).toBe(true);
    });

    test('should refuse to reuse a non-empty directory', async () => {
        const existingFile = path.resolve(CHECKOUT_ROOT, 'package.json');
        await outputFile(existingFile, '{}');
        const runCommand = jest.fn<ReturnType<RunCommand>, Parameters<RunCommand>>();

        const promise = checkoutTarget({
            networkRetryDelaysMs: [],
            ref: 'main',
            repository: REPOSITORY,
            root: CHECKOUT_ROOT,
            runCommand,
            token: undefined,
        });

        await expect(promise).rejects.toThrow('is not empty');
        expect(runCommand).not.toHaveBeenCalled();
    });
});
