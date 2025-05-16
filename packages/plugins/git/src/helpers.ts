// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { filterSensitiveInfoFromRepositoryUrl } from '@dd/core/helpers/strings';
import type { RepositoryData } from '@dd/core/types';
import type { SimpleGit, BranchSummary } from 'simple-git';
import { simpleGit } from 'simple-git';

import { TrackedFilesMatcher } from './trackedFilesMatcher';

// Returns a configured SimpleGit.
export const newSimpleGit = async (cwd?: string): Promise<SimpleGit> => {
    const options = {
        baseDir: cwd || process.cwd(),
        binary: 'git',
        // We are invoking at most 3 git commands at the same time.
        maxConcurrentProcesses: 3,
    };
    try {
        // Attempt to set the baseDir to the root of the repository so the 'git ls-files' command
        // returns the tracked files paths relative to the root of the repository.
        const git = simpleGit(options);
        const root = await git.revparse('--show-toplevel');
        options.baseDir = root;
    } catch {
        // Ignore exception as it will fail if we are not inside a git repository.
    }

    return simpleGit(options);
};

// Returns the remote of the current repository.
export const gitRemote = async (git: SimpleGit): Promise<string> => {
    const remotes = await git.getRemotes(true);
    if (remotes.length === 0) {
        throw new Error('No git remotes available');
    }
    const defaultRemote = await getDefaultRemoteName(git);

    for (const remote of remotes) {
        if (remote.name === defaultRemote) {
            return filterSensitiveInfoFromRepositoryUrl(remote.refs.push);
        }
    }

    // Falling back to picking the first remote in the list if the default remote is not found.
    return filterSensitiveInfoFromRepositoryUrl(remotes[0].refs.push);
};

export const getDefaultRemoteName = async (git: SimpleGit): Promise<string> => {
    try {
        return (await git.getConfig('clone.defaultRemoteName'))?.value ?? 'origin';
    } catch (e) {
        return 'origin';
    }
};

// Returns the hash of the current repository.
export const gitHash = async (git: SimpleGit): Promise<string> => git.revparse('HEAD');

// Returns the tracked files of the current repository.
export const gitTrackedFiles = async (git: SimpleGit): Promise<string[]> => {
    const files = await git.raw('ls-files');

    return files.split(/\r\n|\r|\n/);
};

export const gitBranch = async (git: SimpleGit): Promise<BranchSummary> => git.branch();

export const gitMessage = async (git: SimpleGit): Promise<string> =>
    git.show(['-s', '--format=%s']);

export const gitAuthorAndCommitter = async (git: SimpleGit): Promise<string> =>
    git.show(['-s', '--format=%an,%ae,%aI,%cn,%ce,%cI']);

export const gitRepositoryURL = async (git: SimpleGit): Promise<string> =>
    git.listRemote(['--get-url']);

// Returns the current hash and remote as well as a TrackedFilesMatcher.
//
// To obtain the list of tracked files paths tied to a specific sourcemap, invoke the 'matchSourcemap' method.
export const getRepositoryData = async (
    git: SimpleGit,
    repositoryURL?: string | undefined,
): Promise<RepositoryData> => {
    // Invoke git commands to retrieve the remote, hash and tracked files.
    // We're using Promise.all instead of Promise.allSettled since we want to fail early if
    // any of the promises fails.
    let remote: string;
    let hash: string;
    let trackedFiles: string[];

    if (repositoryURL) {
        [hash, trackedFiles] = await Promise.all([gitHash(git), gitTrackedFiles(git)]);
        remote = repositoryURL;
    } else {
        [remote, hash, trackedFiles] = await Promise.all([
            gitRemote(git),
            gitHash(git),
            gitTrackedFiles(git),
        ]);
    }

    const data = {
        hash,
        remote,
        trackedFilesMatcher: new TrackedFilesMatcher(trackedFiles),
    };

    return data;
};
