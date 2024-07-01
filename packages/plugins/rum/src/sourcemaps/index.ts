// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/log';
import type { GlobalContext } from '@dd/core/types';
import chalk from 'chalk';
import { outdent } from 'outdent';

import type { RumOptionsWithSourcemaps } from '../types';

import { getSourcemapsFiles } from './files';
import { sendSourcemaps } from './sender';

export const uploadSourcemaps = async (
    options: RumOptionsWithSourcemaps,
    context: GlobalContext,
    log: Logger,
) => {
    // Show a pretty summary of the configuration.
    const green = chalk.green.bold;
    const configurationString = Object.entries(options.sourcemaps)
        .map(([key, value]) => `    - ${key}: ${green(value.toString())}`)
        .join('\n');

    // Gather the sourcemaps files.
    const sourcemaps = getSourcemapsFiles(options.sourcemaps);

    const summary = outdent`
    Uploading ${green(sourcemaps.length.toString())} sourcemaps with configuration:
    ${configurationString}
    `;

    log(summary, 'info');

    // Send everything.
    await sendSourcemaps(sourcemaps, options.sourcemaps, context, log);
};
