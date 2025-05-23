// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext } from '@dd/core/types';
import chalk from 'chalk';
import path from 'path';

import type { SourcemapsOptionsWithDefaults, Sourcemap } from '../types';

type PartialSourcemap = Pick<Sourcemap, 'minifiedFilePath' | 'minifiedUrl' | 'relativePath'>;

const decomposePath = (
    options: SourcemapsOptionsWithDefaults,
    context: GlobalContext,
    sourcemapFilePath: string,
): PartialSourcemap => {
    if (path.extname(sourcemapFilePath) !== '.map') {
        throw new Error(`The file ${chalk.green.bold(sourcemapFilePath)} is not a sourcemap.`);
    }

    const minifiedFilePath = sourcemapFilePath.replace(/\.map$/, '');
    const relativePath = minifiedFilePath.replace(context.bundler.outDir, '');
    const minifiedUrl = options.minifiedPathPrefix
        ? path.join(options.minifiedPathPrefix, relativePath)
        : relativePath;

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
            ...decomposePath(options, context, sourcemapFilePath),
            sourcemapFilePath,
            minifiedPathPrefix: options.minifiedPathPrefix,
        };
    });

    return sourcemapFiles;
};
