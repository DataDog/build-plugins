// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { realpathSync } from '@dd/core/helpers/fs';
import { getClosest } from '@dd/core/helpers/paths';
import path from 'path';

// `<dir>/__virtual__/<hash>/<depth>/<rest>`, as created by Yarn PnP for packages with peer
// dependencies. `$$virtual` is the name used by older Yarn versions.
const YARN_VIRTUAL_PATH_RX = /^(.*\/(?:__virtual__|\$\$virtual))\/[^/]+\/(\d+)(\/.*)?$/;

const toPosixPath = (filepath: string) => filepath.replace(/\\/g, '/');

// Remove the query string of a module ID, e.g. `Cart.vue?vue&type=script`.
export const stripQuery = (moduleId: string): string => {
    const queryStart = moduleId.indexOf('?');
    return queryStart === -1 ? moduleId : moduleId.slice(0, queryStart);
};

/**
 * Resolve a Yarn PnP virtual path to the path it stands for, the way Yarn does: for
 * `<dir>/__virtual__/<hash>/<depth>/<rest>`, go up `depth` levels from `<dir>` and append `<rest>`.
 */
export const resolveYarnVirtualPath = (filepath: string): string => {
    const posixPath = toPosixPath(filepath);
    const match = YARN_VIRTUAL_PATH_RX.exec(posixPath);
    if (!match) {
        return filepath;
    }

    const [, virtualDir, depth, rest = ''] = match;
    const target = path.posix.dirname(virtualDir);
    const backtrack = '../'.repeat(Number(depth));
    const resolved = path.posix.join(target, backtrack, rest);

    // A resolved path can itself be virtual.
    return resolveYarnVirtualPath(resolved);
};

// Return the canonical root of the git repository that contains the build root.
export const getRepositoryRoot = (buildRoot: string): string | undefined => {
    const gitPath = getClosest(buildRoot, '.git');
    if (!gitPath) {
        return undefined;
    }

    const repositoryRoot = path.dirname(gitPath);
    return realpathSync(repositoryRoot);
};

// Whether a relative path, with either separator, points outside the directory it's relative to.
export const isOutsideRoot = (relativePath: string): boolean => {
    const posixPath = toPosixPath(relativePath);
    return posixPath === '..' || posixPath.startsWith('../') || path.isAbsolute(relativePath);
};

export const isInsideDirectory = (filepath: string, directory: string): boolean => {
    const relativePath = path.relative(directory, filepath);
    return !isOutsideRoot(relativePath);
};

/**
 * Return the path part of the function IDs of a module: its file, without query string or Yarn PnP
 * virtual folders, relative to `root`. Symlinks are only resolved for files outside `root`, which
 * keeps the file system out of the common case.
 */
export const getFunctionIdPath = (moduleId: string, root: string): string => {
    const moduleFile = stripQuery(moduleId);
    const unvirtualizedPath = resolveYarnVirtualPath(moduleFile);
    const relativePath = path.relative(root, unvirtualizedPath);
    if (!isOutsideRoot(relativePath)) {
        return toPosixPath(relativePath);
    }

    const realPath = realpathSync(unvirtualizedPath);
    const realRelativePath = path.relative(root, realPath);
    return toPosixPath(realRelativePath);
};
