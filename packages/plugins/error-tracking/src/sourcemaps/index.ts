// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';

import type { ErrorTrackingOptionsWithSourcemaps } from '../types';

import type { SourcemapsFilesContext } from './files';
import { getSourcemapsFiles } from './files';
import type { SourcemapsSenderContext } from './sender';
import { sendSourcemaps } from './sender';

export type UploadSourcemapsContext = SourcemapsSenderContext & SourcemapsFilesContext;

export const uploadSourcemaps = async (
    options: ErrorTrackingOptionsWithSourcemaps,
    context: UploadSourcemapsContext,
    log: Logger,
) => {
    // Gather the sourcemaps files.
    const sourcemapsTime = log.time('get sourcemaps files');
    const sourcemaps = getSourcemapsFiles(options.sourcemaps, {
        outDir: context.outDir,
        outputs: context.outputs,
    });
    sourcemapsTime.end();

    // Send everything.
    const sendTime = log.time('send sourcemaps');
    await sendSourcemaps(
        sourcemaps,
        options.sourcemaps,
        {
            apiKey: context.apiKey,
            bundlerName: context.bundlerName,
            git: context.git,
            outDir: context.outDir,
            site: context.site,
            version: context.version,
        },
        log,
    );
    sendTime.end();
};
