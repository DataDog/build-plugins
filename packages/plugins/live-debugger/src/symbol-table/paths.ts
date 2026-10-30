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

const isOutside = (relativePath: string) =>
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath);

export const isInsideDirectory = (filepath: string, directory: string): boolean => {
    const relativePath = path.relative(directory, filepath);
    return relativePath === '' || !isOutside(relativePath);
};

/**
 * Return a function that converts the module path of a function ID to a path relative to the
 * repository root, or to undefined when the module is outside the repository.
 */
export const createSourceFileResolver = (buildRoot: string, repositoryRoot: string) => {
    const cache = new Map<string, string | undefined>();

    return (modulePath: string): string | undefined => {
        if (cache.has(modulePath)) {
            return cache.get(modulePath);
        }

        const moduleFile = stripQuery(modulePath);
        const absolutePath = path.resolve(buildRoot, moduleFile);
        const unvirtualizedPath = resolveYarnVirtualPath(absolutePath);
        const realPath = realpathSync(unvirtualizedPath);
        const relativePath = path.relative(repositoryRoot, realPath);
        const sourceFile = isOutside(relativePath) ? undefined : toPosixPath(relativePath);

        cache.set(modulePath, sourceFile);
        return sourceFile;
    };
};
