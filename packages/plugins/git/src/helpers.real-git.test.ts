// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFileSync, rmSync } from '@dd/core/helpers/fs';
import { getUniqueId } from '@dd/core/helpers/strings';
import {
    getRepositoryData,
    gitHash,
    gitRemote,
    newSimpleGit,
} from '@dd/internal-git-plugin/helpers';
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import { execFileSync } from 'child_process';
import path from 'path';

const REMOTE_URL = 'https://git.example.com/DataDog/example.git';
const UPSTREAM_URL = 'https://git.example.com/DataDog/upstream.git';
const FORK_URL = 'https://git.example.com/someone/example.git';
const AUTHOR_NAME = 'QA';
const AUTHOR_EMAIL = 'qa@example.com';
const BRANCH = 'main';
const COMMIT_MESSAGE = 'Initial commit';
const TRACKED_FILE = 'src/index.js';

// Only PATH, so ambient GIT_* variables and the developer's git config can't shape the fixture.
const FIXTURE_GIT_ENV = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
};

const runGit = (cwd: string, args: string[]): string =>
    execFileSync(
        'git',
        [
            ...['-c', `user.name=${AUTHOR_NAME}`, '-c', `user.email=${AUTHOR_EMAIL}`],
            ...['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'],
            ...args,
        ],
        { cwd, encoding: 'utf-8', env: FIXTURE_GIT_ENV },
    ).trim();

// simple-git 4 strips GIT_* from its git processes but passes these through, so they are how the
// test keeps the user-level git config and a localized git out of the code under test.
const ISOLATED_ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'LC_ALL'] as const;

describe('Git Plugin helpers against a real repository', () => {
    const initialEnv = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
    let tempDir = '';
    let repository = '';
    let head = '';

    beforeEach(() => {
        const seed = `git-helpers-${getUniqueId()}`;
        tempDir = getTempWorkingDir(seed);
        repository = path.join(tempDir, 'repository');
        const trackedFilePath = path.join(repository, TRACKED_FILE);
        outputFileSync(trackedFilePath, 'export {};\n');
        runGit(repository, ['init', '--quiet']);
        runGit(repository, ['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`]);
        runGit(repository, ['remote', 'add', 'origin', REMOTE_URL]);
        runGit(repository, ['add', '.']);
        runGit(repository, ['commit', '--quiet', '-m', COMMIT_MESSAGE]);
        head = runGit(repository, ['rev-parse', 'HEAD']);
        process.env.HOME = tempDir;
        delete process.env.XDG_CONFIG_HOME;
        process.env.LC_ALL = 'C';
    });

    afterEach(() => {
        for (const [key, value] of initialEnv) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        if (tempDir) {
            rmSync(tempDir);
            tempDir = '';
        }
    });

    test('Should read the repository data with the git commands the plugin runs', async () => {
        const sourceDir = path.join(repository, 'src');
        const git = await newSimpleGit(sourceDir);

        const data = await getRepositoryData(git);

        const author = { name: AUTHOR_NAME, email: AUTHOR_EMAIL };
        expect(data).toMatchObject({
            hash: head,
            branch: BRANCH,
            remote: REMOTE_URL,
            commit: { hash: head, message: COMMIT_MESSAGE, author, committer: author },
        });
        const trackedFiles = data.trackedFilesMatcher.rawTrackedFilesList();
        expect(trackedFiles).toContain(TRACKED_FILE);
    });

    test('Should report origin when several remotes exist and no default is configured', async () => {
        runGit(repository, ['remote', 'add', 'aaa-fork', FORK_URL]);
        const git = await newSimpleGit(repository);

        const remote = await gitRemote(git);

        expect(remote).toBe(REMOTE_URL);
    });

    test('Should report the remote named by clone.defaultRemoteName in the repository config', async () => {
        runGit(repository, ['remote', 'add', 'upstream', UPSTREAM_URL]);
        runGit(repository, ['config', 'clone.defaultRemoteName', 'upstream']);
        const git = await newSimpleGit(repository);

        const remote = await gitRemote(git);

        expect(remote).toBe(UPSTREAM_URL);
    });

    test('Should create a client outside a repository and fail only on git commands', async () => {
        const notARepository = path.join(tempDir, 'not-a-repository');
        const placeholderPath = path.join(notARepository, 'placeholder');
        outputFileSync(placeholderPath, '');

        const git = await newSimpleGit(notARepository);

        const hash = gitHash(git);
        await expect(hash).rejects.toThrow('not a git repository');
    });
});
