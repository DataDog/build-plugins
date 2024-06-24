// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import chalk from 'chalk';
import glob from 'glob';
import path from 'path';

import type { RumSourcemapsOptionsWithDefaults, Sourcemap } from '../types';

type PartialSourcemap = Pick<Sourcemap, 'minifiedFilePath' | 'minifiedUrl' | 'relativePath'>;

const getGlobPattern = (basePath: string) => {
    // Normalizing the basePath to resolve .. and .
    // Always using the posix version to avoid \ on Windows.
    const newPath = path.posix.normalize(basePath);
    return path.join(newPath, '**/*.@(js|mjs).map');
};

const decomposePath = (
    options: RumSourcemapsOptionsWithDefaults,
    sourcemapFilePath: string,
): PartialSourcemap => {
    if (path.extname(sourcemapFilePath) !== '.map') {
        throw new Error(`The file ${chalk.green.bold(sourcemapFilePath)} is not a sourcemap.`);
    }

    const minifiedFilePath = sourcemapFilePath.replace(/\.map$/, '');
    const relativePath = minifiedFilePath.replace(options.basePath, '');
    const minifiedUrl = options.minifiedPathPrefix
        ? path.join(options.minifiedPathPrefix, relativePath)
        : relativePath;

    return {
        minifiedFilePath,
        minifiedUrl,
        relativePath,
    };
};

export const getSourcemapsFiles = (options: RumSourcemapsOptionsWithDefaults): Sourcemap[] => {
    const globPattern = getGlobPattern(options.basePath);
    const sourcemapFilesList = glob.sync(globPattern);
    const sourcemapFiles = sourcemapFilesList.map((sourcemapFilePath) => {
        return {
            ...decomposePath(options, sourcemapFilePath),
            sourcemapFilePath,
            minifiedPathPrefix: options.minifiedPathPrefix,
        };
    });

    return sourcemapFiles;
};
