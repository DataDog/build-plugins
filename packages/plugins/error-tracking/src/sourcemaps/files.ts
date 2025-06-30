// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext } from '@dd/core/types';
import chalk from 'chalk';
import path from 'path';

import type { SourcemapsOptionsWithDefaults, Sourcemap, MinifiedPathPrefix } from '../types';

type PartialSourcemap = Pick<Sourcemap, 'minifiedFilePath' | 'minifiedUrl' | 'relativePath'>;

// Helper function to safely join URLs or paths
export const joinUrlOrPath = (prefix: MinifiedPathPrefix, relativePath: string): string => {
    // Prefix is a path.
    if (prefix.startsWith('/')) {
        // Simply join the prefix with the relative path.
        return path.join(prefix, relativePath);
    }

    // Prefix is a URL.
    try {
        // Ensure it ends with a slash for deterministic URL path joining.
        const normalizedPrefix = prefix.replace(/\/*$/, '/');
        const url = new URL(normalizedPrefix);
        // Ensure the relative path does not start with a slash
        // otherwise it will act as a "root" path when joined with the url.
        const normalizedRelativePath = relativePath.replace(/^[\\/]*/, '');
        return new URL(normalizedRelativePath, url).href;
    } catch {
        // Fallback to simple concatenation if URL constructor fails
        return `${prefix}${relativePath}`;
    }
};

export const decomposePath = (
    prefix: MinifiedPathPrefix,
    // This is coming from context.bundler.outDir, which is absolute.
    absoluteOutDir: string,
    sourcemapFilePath: string,
): PartialSourcemap => {
    if (path.extname(sourcemapFilePath) !== '.map') {
        throw new Error(`The file ${chalk.green.bold(sourcemapFilePath)} is not a sourcemap.`);
    }

    const minifiedFilePath = sourcemapFilePath.replace(/\.map$/, '');
    const relativePath = path.relative(absoluteOutDir, minifiedFilePath);
    const minifiedUrl = joinUrlOrPath(prefix, relativePath);

    return {
        minifiedFilePath,
        minifiedUrl,
        relativePath,
    };
};

export const getSourcemapsFiles = (
    options: SourcemapsOptionsWithDefaults,
    context: GlobalContext,
): Sourcemap[] => {
    if (!context.build.outputs || context.build.outputs.length === 0) {
        throw new Error('No output files found.');
    }

    const sourcemapFilesList = context.build.outputs
        .filter((file) => file.filepath.endsWith('.map'))
        .map((file) => file.filepath);

    const sourcemapFiles = sourcemapFilesList.map((sourcemapFilePath) => {
        return {
            ...decomposePath(options.minifiedPathPrefix, context.bundler.outDir, sourcemapFilePath),
            sourcemapFilePath,
            minifiedPathPrefix: options.minifiedPathPrefix,
        };
    });

    return sourcemapFiles;
};
