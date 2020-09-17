import fs from 'fs-extra';
import path from 'path';

describe('Output Files', () => {
    const reportMock = {
        timings: {
            tapables: {},
            loaders: {},
            modules: {},
        },
        dependencies: {},
    };

    const getExistsProms = async (output: string, context: string) => {
        const { hooks } = require('../outputFiles');
        await hooks.output.call(
            // eslint-disable-next-line no-console
            { log: console.log, options: { output, context } },
            {
                report: reportMock,
                metrics: {},
                stats: { toJson: () => ({}) },
            }
        );

        return [
            fs.pathExists(path.join(output, 'dependencies.json')),
            fs.pathExists(path.join(output, 'timings.json')),
            fs.pathExists(path.join(output, 'stats.json')),
            fs.pathExists(path.join(output, 'metrics.json')),
        ];
    };

    const getRemoveProms = (output: string) => {
        return [fs.remove(output)];
    };

    test('It should allow an absolute and relative path', async () => {
        // Absolute path.
        const output = path.join(__dirname, '/test/');
        const existProms = await getExistsProms(output, __dirname);
        const exists = await Promise.all(existProms);

        expect(exists.reduce((prev, curr) => prev && curr, true));

        // Cleaning
        await Promise.all(getRemoveProms(output));
    });

    test('It should allow a relative path', async () => {
        // Relative path
        const output = './test2/';
        const existProms = await getExistsProms(output, __dirname);
        const exists = await Promise.all(existProms);

        expect(exists.reduce((prev, curr) => prev && curr, true));

        // Cleaning
        await Promise.all(getRemoveProms(path.join(__dirname, output)));
    });

    test('It should export hooks', () => {
        const outputFiles = require('../outputFiles');
        expect(typeof outputFiles.hooks).toBe('object');
    });
});
