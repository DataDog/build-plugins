// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { formatDuration, outputJson } from '@dd/core/helpers';
import type { Logger } from '@dd/core/log';
import type { MetricToSend, OutputOptions, Report } from '@dd/telemetry-plugins/types';
import path from 'path';

type Files = 'timings' | 'metrics';

type FilesToWrite = {
    [key in Files]?: { content: any };
};

export const outputFiles = async (
    data: {
        report?: Report;
        metrics: MetricToSend[];
    },
    outputOptions: OutputOptions,
    log: Logger,
    cwd: string,
) => {
    // Don't write any file if it's not enabled.
    if (typeof outputOptions !== 'string' && typeof outputOptions !== 'object' && !outputOptions) {
        return;
    }

    const { report, metrics } = data;

    const startWriting = Date.now();
    let destination = '';
    const files = {
        timings: true,
        metrics: true,
    };

    if (typeof outputOptions === 'object') {
        destination = outputOptions.destination;
        files.timings = outputOptions.timings || false;
        files.metrics = outputOptions.metrics || false;
    } else if (typeof outputOptions === 'string') {
        destination = outputOptions;
    }

    const outputPath = path.resolve(cwd, destination);

    try {
        const errors: { [key: string]: Error } = {};
        const filesToWrite: FilesToWrite = {};

        if (files.timings && report?.timings) {
            filesToWrite.timings = {
                content: {
                    tapables: report.timings.tapables
                        ? Array.from(report.timings.tapables.values())
                        : null,
                    loaders: report.timings.loaders
                        ? Array.from(report.timings.loaders.values())
                        : null,
                    modules: report.timings.modules
                        ? Array.from(report.timings.modules.values())
                        : null,
                },
            };
        }

        if (metrics && files.metrics) {
            filesToWrite.metrics = { content: metrics };
        }

        const proms = Object.entries(filesToWrite).map(async ([filename, file]): Promise<void> => {
            const start = Date.now();
            log(`Start writing ${filename}.json.`);
            try {
                await outputJson(path.join(outputPath, `${filename}.json`), file.content);
                log(`Wrote ${filename}.json in ${formatDuration(Date.now() - start)}`);
            } catch (e: any) {
                log(
                    `Failed to write ${filename}.json in ${formatDuration(Date.now() - start)}`,
                    'error',
                );
                errors[filename] = e;
            }
        });

        // We can't use Promise.allSettled because we want to support NodeJS 10+
        await Promise.all(proms);
        log(`Wrote files in ${formatDuration(Date.now() - startWriting)}.`);
        // If we had some errors.
        const fileErrored = Object.keys(errors);
        if (fileErrored.length) {
            log(
                `Couldn't write files.\n${fileErrored.map(
                    (file) => `  - ${file}: ${errors[file].toString()}`,
                )}`,
                'error',
            );
        }
    } catch (e) {
        log(`Couldn't write files. ${e}`, 'error');
    }
};
