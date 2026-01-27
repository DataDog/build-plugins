// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { glob } from 'glob';
import path from 'path';

export type Asset = {
    absolutePath: string;
    relativePath: string;
};

/**
 * Finds the common directory prefix across all paths.
 * Returns the longest common directory path that all paths share.
 * @param paths - Array of relative paths
 * @returns Common directory prefix (without trailing separator), or empty string if no common prefix
 */
export const findCommonPrefix = (paths: string[]): string => {
    if (paths.length === 0) {
        return '';
    }

    const segments = paths[0].split(path.sep);
    let commonPrefix = '';

    for (let i = 0; i < segments.length - 1; i++) {
        const prefix = segments.slice(0, i + 1).join(path.sep);
        const allMatch = paths.every((p) => p.startsWith(`${prefix}${path.sep}`));
        if (allMatch) {
            commonPrefix = prefix;
        } else {
            break;
        }
    }

    return commonPrefix;
};

export const collectAssets = async (patterns: string[], cwd: string): Promise<Asset[]> => {
    const matches = (
        await Promise.all(
            patterns.map((pattern) => {
                return glob(pattern, { absolute: true, cwd, nodir: true });
            }),
        )
    ).flat();

    // Compute relative paths from cwd
    const relativePaths = Array.from(new Set(matches)).map((match) => path.relative(cwd, match));

    // Find common directory prefix across all paths
    const commonPrefix = findCommonPrefix(relativePaths);

    const assets: Asset[] = relativePaths.map((relativePath, index) => {
        // Strip common prefix to get paths relative to the common directory
        const strippedPath = commonPrefix
            ? relativePath.slice(commonPrefix.length + 1)
            : relativePath;

        return {
            absolutePath: matches[index],
            relativePath: strippedPath,
        };
    });

    return assets;
};
