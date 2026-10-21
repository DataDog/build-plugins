// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, mkdir } from '@dd/core/helpers/fs';
import { glob } from 'glob';

import { CanaryCommandError, runCheckedCommand, withRetries } from './runner';
import type { CommandResult, RunCommand, TargetRepository } from './types';

// A manual override wins over a temporary pin, which wins over the tracked branch.
export const getCheckoutRef = (
    repository: TargetRepository,
    override: string | undefined,
): string => {
    return override ?? repository.pin?.commit ?? repository.branch;
};

// Passes the token to git through GIT_CONFIG_* variables, so it never appears in a
// command line, a command log, or the checkout's .git/config.
export const getGitAuthEnvironment = (token: string | undefined): Record<string, string> => {
    if (!token) {
        return {};
    }
    const credentials = Buffer.from(`x-access-token:${token}`).toString('base64');
    return {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credentials}`,
    };
};

const assertEmptyDirectory = async (root: string): Promise<void> => {
    if (!existsSync(root)) {
        return;
    }
    const entries = await glob('*', { cwd: root, dot: true });
    if (entries.length > 0) {
        throw new CanaryCommandError(
            `${root} is not empty. canary-checkout only creates fresh checkouts.`,
        );
    }
};

// Fetches exactly one commit, so even very large repositories check out quickly.
// Works with a branch name or a full commit SHA.
export const checkoutTarget = async ({
    networkRetryDelaysMs,
    ref,
    repository,
    root,
    runCommand,
    token,
}: {
    networkRetryDelaysMs: number[];
    ref: string;
    repository: TargetRepository;
    root: string;
    runCommand: RunCommand;
    token: string | undefined;
}): Promise<string> => {
    await assertEmptyDirectory(root);
    await mkdir(root);

    const runGit = (
        args: string[],
        label: string,
        env: Record<string, string> = {},
    ): Promise<CommandResult> => {
        return runCheckedCommand(runCommand, {
            command: 'git',
            args,
            cwd: root,
            env: { GIT_TERMINAL_PROMPT: '0', ...env },
            label,
        });
    };

    const remoteUrl = `https://github.com/${repository.name}.git`;
    const authEnvironment = getGitAuthEnvironment(token);
    await runGit(['init', '--quiet'], 'initialize target checkout');
    await runGit(['remote', 'add', 'origin', remoteUrl], 'add target remote');
    await withRetries(
        () =>
            runGit(
                ['fetch', '--depth', '1', '--no-tags', 'origin', ref],
                `fetch ${repository.name} ${ref}`,
                authEnvironment,
            ),
        networkRetryDelaysMs,
    );
    await runGit(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], `check out ${ref}`);
    const revision = await runGit(['rev-parse', 'HEAD'], 'resolve target commit');
    return revision.output.trim();
};
