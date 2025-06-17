// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext } from '@dd/core/types';
import chalk from 'chalk';
import path from 'path';

import type { SourcemapsOptionsWithDefaults, Sourcemap } from '../types';

type PartialSourcemap = Pick<Sourcemap, 'minifiedFilePath' | 'minifiedUrl' | 'relativePath'>;

// Helper function to safely join URLs or paths
export const joinUrlOrPath = (base: string, relativePath: string): string => {
    // Check if base is a URL by looking for protocol
    if (base.includes('://')) {
        // Handle URL joining
        try {
            // Ensure base URL ends with / for proper directory joining
            const normalizedBase = base.endsWith('/') ? base : `${base}/`;
            const url = new URL(normalizedBase);
            // Remove leading slash from relativePath since URL constructor handles it
            const cleanPath = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
            return new URL(cleanPath, url).href;
        } catch {
            // Fallback to simple concatenation if URL constructor fails
            return base.endsWith('/')
                ? `${base}${relativePath.slice(1)}`
                : `${base}${relativePath}`;
        }
    } else {
        // Handle file path joining
        return path.join(base, relativePath);
    }
};

export const decomposePath = (
    options: SourcemapsOptionsWithDefaults,
    context: GlobalContext,
    sourcemapFilePath: string,
): PartialSourcemap => {
    if (path.extname(sourcemapFilePath) !== '.map') {
        throw new Error(`The file ${chalk.green.bold(sourcemapFilePath)} is not a sourcemap.`);
    }

    const minifiedFilePath = sourcemapFilePath.replace(/\.map$/, '');
    const relativePath = path.relative(context.bundler.outDir, minifiedFilePath);
    const minifiedUrl = joinUrlOrPath(options.minifiedPathPrefix, relativePath);

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
