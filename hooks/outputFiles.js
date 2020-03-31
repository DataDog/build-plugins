/* eslint-disable no-console */
const path = require('path');
const { outputJson } = require('fs-extra');

const output = async function output({ report, metrics, stats }) {
    if (typeof this.options.output === 'string') {
        const PLUGIN_NAME = this.constructor.name;
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
            console.log(
                `[${PLUGIN_NAME}] Wrote files in ${Date.now() -
                    startWriting}ms.`
            );
        } catch (e) {
            console.log(e);
            console.error(
                `[${PLUGIN_NAME}] Couldn't write files. ${e.toString()}`
            );
        }
    }
};

module.exports = { hooks: { output } };
