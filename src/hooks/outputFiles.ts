// Unless explicitly stated otherwise all files in this repository are licensed
// under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

const path = require('path');
const { outputJson } = require('fs-extra');

const output = async function output({ report, metrics, stats }) {
    if (typeof this.options.output === 'string') {
        const startWriting = Date.now();
        const outputPath = path.join(this.options.context, this.options.output);
        try {
            const spaces = '  ';
            await Promise.all([
                outputJson(
                    path.join(outputPath, 'timings.json'),
                    {
                        tappables: report.timings.tappables,
                        loaders: report.timings.loaders,
                        modules: report.timings.modules
                    },
                    { spaces }
                ),
                outputJson(
                    path.join(outputPath, 'dependencies.json'),
                    report.dependencies,
                    { spaces }
                ),
                outputJson(
                    path.join(outputPath, 'stats.json'),
                    stats.toJson({ children: false }),
                    {
                        spaces
                    }
                ),
                metrics &&
                    outputJson(path.join(outputPath, 'metrics.json'), metrics, {
                        spaces
                    })
            ]);
            this.log(`Wrote files in ${Date.now() - startWriting}ms.`);
        } catch (e) {
            this.log(`Couldn't write files. ${e.toString()}`, 'error');
        }
    }
};

module.exports = { hooks: { output } };
