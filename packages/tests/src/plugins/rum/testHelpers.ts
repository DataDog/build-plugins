// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { TrackedFilesMatcher } from '@dd/core/plugins/git/trackedFilesMatcher';
import type { RepositoryData } from '@dd/core/types';
import type { Metadata, MultipartValue, Payload } from '@dd/rum-plugins/sourcemaps/payload';
import type {
    RumSourcemapsOptions,
    RumSourcemapsOptionsWithDefaults,
    Sourcemap,
} from '@dd/rum-plugins/types';
import { INTAKE_URL } from '@dd/tests/helpers/mocks';

export const getMinimalSourcemapsConfiguration = (
    options: Partial<RumSourcemapsOptions> = {},
): RumSourcemapsOptions => {
    return {
        minifiedPathPrefix: '/prefix',
        releaseVersion: '1.0.0',
        service: 'rum-build-plugin-sourcemaps',
        ...options,
    };
};

export const getSourcemapsConfiguration = (
    options: Partial<RumSourcemapsOptions> = {},
): RumSourcemapsOptionsWithDefaults => {
    return {
        bailOnError: false,
        dryRun: false,
        maxConcurrency: 10,
        intakeUrl: INTAKE_URL,
        minifiedPathPrefix: '/prefix',
        releaseVersion: '1.0.0',
        service: 'rum-build-plugin-sourcemaps',
        ...options,
    };
};

export const getSourcemapMock = (options: Partial<Sourcemap> = {}): Sourcemap => {
    return {
        minifiedFilePath: '/path/to/minified.min.js',
        minifiedPathPrefix: '/prefix',
        minifiedUrl: '/prefix/path/to/minified.js',
        relativePath: '/path/to/minified.min.js',
        sourcemapFilePath: '/path/to/sourcemap.js.map',
        ...options,
    };
};

export const getMetadataMock = (options: Partial<Metadata> = {}): Metadata => {
    return {
        plugin_version: '1.0.0',
        project_path: '/path/to/project',
        service: 'rum-build-plugin-sourcemaps',
        type: 'js_sourcemap',
        version: '1.0.0',
        ...options,
    };
};

export const getRepositoryDataMock = (options: Partial<RepositoryData> = {}): RepositoryData => {
    return {
        hash: 'hash',
        remote: 'remote',
        trackedFilesMatcher: new TrackedFilesMatcher(['/path/to/minified.min.js']),
        ...options,
    };
};

export const getPayloadMock = (
    options: Partial<Payload> = {},
    content: [string, MultipartValue][] = [],
): Payload => {
    return {
        content: new Map<string, MultipartValue>([
            [
                'source_map',
                {
                    type: 'file',
                    path: '/path/to/sourcemap.js.map',
                    options: { filename: 'source_map', contentType: 'application/json' },
                },
            ],
            [
                'minified_file',
                {
                    type: 'file',
                    path: '/path/to/minified.min.js',
                    options: {
                        filename: 'minified_file',
                        contentType: 'application/javascript',
                    },
                },
            ],
            ...content,
        ]),
        errors: [],
        warnings: [],
        ...options,
    };
};
