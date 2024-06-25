// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { RepositoryData } from '@dd/core/types';
import { promises as fs } from 'fs';

import type { Sourcemap } from '../types';

export type Payload = {
    content: Map<string, MultipartValue>;
    errors: string[];
    warnings: string[];
};

export type Metadata = {
    plugin_version: string;
    project_path: string;
    service: string;
    type: string;
    version: string;
    git_repository_url?: string;
    git_commit_sha?: string;
};

type FileValidity = {
    empty: boolean;
    exists: boolean;
};

type SourcemapValidity = {
    file: FileValidity;
    sourcemap: FileValidity;
    repeatedPrefix: string;
};

interface AppendOptions {
    filename?: string;
}

interface MultipartStringValue {
    type: 'string';
    value: string;
    options: AppendOptions;
}

interface MultipartFileValue {
    type: 'file';
    path: string;
    options: AppendOptions;
}

type MultipartValue = MultipartStringValue | MultipartFileValue;

const SLASH_RX = /[/]+|[\\]+/g;
const SLASH_TRIM_RX = /^[/]+|^[\\]+|[/]+$|[\\]+$/g;

// Verify any repeated pattern between the path and prefix.
export const prefixRepeat = (path: string, prefix: string): string => {
    const pathParts = path.replace(SLASH_TRIM_RX, '').split(SLASH_RX);
    const prefixParts = prefix.replace(SLASH_TRIM_RX, '').split(SLASH_RX);
    const normalizedPath = pathParts.join('/');

    let result = '';

    for (let i = 0; i < prefixParts.length; i += 1) {
        const partialPrefix = prefixParts.slice(-i).join('/');
        if (normalizedPath.startsWith(partialPrefix)) {
            result = partialPrefix;
        }
    }

    return result;
};

// Verify that every files are available.
export const checkFile = async (path: string): Promise<FileValidity> => {
    const validity: FileValidity = {
        empty: false,
        exists: true,
    };

    try {
        const stats = await fs.stat(path);
        if (stats.size === 0) {
            validity.empty = true;
        }
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            validity.exists = false;
        } else {
            // Other kind of error
            throw error;
        }
    }

    return validity;
};

const getSourcemapValidity = async (
    sourcemap: Sourcemap,
    prefix: string,
): Promise<SourcemapValidity> => {
    const [resultMinFile, resultSourcemap] = await Promise.all([
        checkFile(sourcemap.minifiedFilePath),
        checkFile(sourcemap.sourcemapFilePath),
    ]);

    return {
        file: resultMinFile,
        sourcemap: resultSourcemap,
        repeatedPrefix: prefixRepeat(sourcemap.relativePath, prefix),
    };
};

export const getPayload = async (
    sourcemap: Sourcemap,
    metadata: Metadata,
    prefix: string,
    git?: RepositoryData,
): Promise<Payload> => {
    const validity = await getSourcemapValidity(sourcemap, prefix);
    const errors: string[] = [];
    const warnings: string[] = [];
    const content = new Map<string, MultipartValue>([
        [
            'event',
            {
                type: 'string',
                options: {
                    filename: 'event',
                },
                value: JSON.stringify({
                    ...metadata,
                    minified_url: sourcemap.minifiedUrl,
                }),
            },
        ],
        [
            'source_map',
            {
                type: 'file',
                path: sourcemap.sourcemapFilePath,
                options: { filename: 'source_map' },
            },
        ],
        [
            'minified_file',
            {
                type: 'file',
                path: sourcemap.minifiedFilePath,
                options: { filename: 'minified_file' },
            },
        ],
    ]);

    // Add git payload if available.
    if (git) {
        try {
            content.set('repository', {
                type: 'string',
                options: {
                    filename: 'repository',
                },
                value: JSON.stringify({
                    data: [
                        {
                            files: git.trackedFilesMatcher.matchSourcemap(
                                sourcemap.sourcemapFilePath,
                                () => {
                                    warnings.push(
                                        `No tracked files found for sources contained in ${sourcemap.sourcemapFilePath}`,
                                    );
                                },
                            ),
                            hash: git.hash,
                            repository_url: git.remote,
                        },
                    ],
                    // NOTE: Make sure to update the version if the format of the JSON payloads changes in any way.
                    version: 1,
                }),
            });
        } catch (error: any) {
            warnings.push(
                `Could not attach git data for sourcemap ${sourcemap.sourcemapFilePath}: ${error.message}`,
            );
        }
    }

    if (validity.file.empty) {
        errors.push(`Minified file is empty: ${sourcemap.minifiedFilePath}`);
    }
    if (!validity.file.exists) {
        errors.push(`Minified file not found: ${sourcemap.minifiedFilePath}`);
    }
    if (validity.sourcemap.empty) {
        errors.push(`Sourcemap file is empty: ${sourcemap.sourcemapFilePath}`);
    }
    if (!validity.sourcemap.exists) {
        errors.push(`Sourcemap file not found: ${sourcemap.sourcemapFilePath}`);
    }
    if (validity.repeatedPrefix) {
        warnings.push(
            `The minified file path contains a repeated pattern with the minified path prefix: ${validity.repeatedPrefix}`,
        );
    }

    return { content, errors, warnings };
};
