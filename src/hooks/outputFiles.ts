// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';
import { outputJson } from 'fs-extra';

import { HooksContext } from '../types';
import { BuildPlugin } from '../webpack';

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
            const spaces = '  ';
            if (files.timings) {
                await outputJson(
                    path.join(outputPath, 'timings.json'),
                    {
                        tapables: report.timings.tapables,
                        loaders: report.timings.loaders,
                        modules: report.timings.modules,
                    },
                    { spaces }
                );
                this.log(`Wrote timings.json`);
            }
            if (files.dependencies) {
                await outputJson(path.join(outputPath, 'dependencies.json'), report.dependencies, {
                    spaces,
                });
                this.log(`Wrote dependencies.json`);
            }
            if (files.stats) {
                await outputJson(
                    path.join(outputPath, 'stats.json'),
                    stats.toJson({ children: false }),
                    { spaces }
                );
                this.log(`Wrote stats.json`);
            }
            if (metrics && files.metrics) {
                await outputJson(path.join(outputPath, 'metrics.json'), metrics, { spaces });
                this.log(`Wrote metrics.json`);
            }

            this.log(`Wrote files in ${Date.now() - startWriting}ms.`);
        } catch (e) {
            this.log(`Couldn't write files. ${e.toString()}`, 'error');
        }
    }
};

export const hooks = { output };
