// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';
import { outputFile } from 'fs-extra';

import { HooksContext } from '../types';
import { BuildPlugin } from '../webpack';
import { formatDuration } from '../helpers';

const output = async function output(this: BuildPlugin, { report, metrics, stats }: HooksContext) {
    const opts = this.options.output;
    if (typeof opts === 'string' || typeof opts === 'object') {
        const startWriting = Date.now();
        let destination;
        const files = {
            timings: true,
            dependencies: true,
            stats: true,
            metrics: true,
        };

        if (typeof opts === 'object') {
            destination = opts.destination;
            files.timings = opts.timings || false;
            files.dependencies = opts.dependencies || false;
            files.stats = opts.stats || false;
            files.metrics = opts.metrics || false;
        } else {
            destination = opts;
        }

        const outputPath = path.resolve(this.options.context!, destination);

        try {
            const errors: { [key: string]: Error } = {};
            const filesToWrite: { [key: string]: { content: any } } = {};
            if (files.timings) {
                filesToWrite.timings = {
                    content: {
                        tapables: report.timings.tapables,
                        loaders: report.timings.loaders,
                        modules: report.timings.modules,
                    },
                };
            }
            if (files.dependencies) {
                filesToWrite.dependencies = { content: report.dependencies };
            }
            if (files.stats) {
                filesToWrite.stats = { content: stats.toJson({ children: false }) };
            }
            if (metrics && files.metrics) {
                filesToWrite.metrics = { content: metrics };
            }

            const proms = Object.keys(filesToWrite).map((file) => {
                const start = Date.now();
                this.log(`Start writing ${file}.json.`);

                return outputFile(
                    path.join(outputPath, `${file}.json`),
                    JSON.stringify(filesToWrite[file].content, null, 4)
                )
                    .then(() => {
                        this.log(`Wrote ${file}.json in ${formatDuration(Date.now() - start)}`);
                    })
                    .catch((e) => {
                        this.log(
                            `Failed to write ${file}.json in ${formatDuration(Date.now() - start)}`,
                            'error'
                        );
                        errors[file] = e;
                    });
            });

            // We can't use Promise.allSettled because we want to support NodeJS 10+
            await Promise.all(proms);
            this.log(`Wrote files in ${formatDuration(Date.now() - startWriting)}.`);
            // If we had some errors.
            const fileErrored = Object.keys(errors);
            if (fileErrored.length) {
                this.log(
                    `Couldn't write files.\n${fileErrored.map(
                        (file) => `  - ${file}: ${errors[file].toString()}`
                    )}`,
                    'error'
                );
            }
        } catch (e) {
            this.log(`Couldn't write files. ${e.toString()}`, 'error');
        }
    }
};

export const hooks = { output };
