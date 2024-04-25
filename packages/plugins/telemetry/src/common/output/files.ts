import { formatDuration, writeFile } from '@datadog/build-plugins-core/helpers';
import path from 'path';

import { CONFIG_KEY } from '../../constants';
import type { Context, OptionsWithTelemetryEnabled } from '../../types';

type Files = 'timings' | 'dependencies' | 'bundler' | 'metrics';

type FilesToWrite = {
    [key in Files]?: { content: any };
};

export const outputFiles = async (context: Context, options: OptionsWithTelemetryEnabled) => {
    const { report, metrics, bundler } = context;
    const opts = options[CONFIG_KEY].output;

    if (typeof opts !== 'string' && typeof opts !== 'object') {
        return;
    }

    const startWriting = Date.now();
    let destination;
    const files = {
        timings: true,
        dependencies: true,
        bundler: true,
        metrics: true,
        result: true,
    };

    if (typeof opts === 'object') {
        destination = opts.destination;
        files.timings = opts.timings || false;
        files.dependencies = opts.dependencies || false;
        files.bundler = opts.bundler || false;
        files.metrics = opts.metrics || false;
    } else {
        destination = opts;
    }

    const outputPath = path.resolve(options[CONFIG_KEY]?.context!, destination);

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

        if (files.dependencies && report?.dependencies) {
            filesToWrite.dependencies = { content: report.dependencies };
        }

        if (files.bundler) {
            if (bundler.webpack) {
                filesToWrite.bundler = { content: bundler.webpack.toJson({ children: false }) };
            }
            if (bundler.esbuild) {
                filesToWrite.bundler = { content: bundler.esbuild };
            }
        }

        if (metrics && files.metrics) {
            filesToWrite.metrics = { content: metrics };
        }

        const proms = (Object.keys(filesToWrite) as Files[]).map((file) => {
            const start = Date.now();
            console.log(`Start writing ${file}.json.`);

            return writeFile(path.join(outputPath, `${file}.json`), filesToWrite[file]!.content)
                .then(() => {
                    console.log(`Wrote ${file}.json in ${formatDuration(Date.now() - start)}`);
                })
                .catch((e) => {
                    console.log(
                        `Failed to write ${file}.json in ${formatDuration(Date.now() - start)}`,
                        'error',
                    );
                    errors[file] = e;
                });
        });

        // We can't use Promise.allSettled because we want to support NodeJS 10+
        await Promise.all(proms);
        console.log(`Wrote files in ${formatDuration(Date.now() - startWriting)}.`);
        // If we had some errors.
        const fileErrored = Object.keys(errors);
        if (fileErrored.length) {
            console.log(
                `Couldn't write files.\n${fileErrored.map(
                    (file) => `  - ${file}: ${errors[file].toString()}`,
                )}`,
                'error',
            );
        }
    } catch (e) {
        console.log(`Couldn't write files. ${e}`, 'error');
    }
};
