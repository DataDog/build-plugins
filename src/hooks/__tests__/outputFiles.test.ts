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

    const getExistsProms = (output: string) => {
        return [
            fs.pathExists(path.join(output, 'dependencies.json')),
            fs.pathExists(path.join(output, 'timings.json')),
            fs.pathExists(path.join(output, 'stats.json')),
            fs.pathExists(path.join(output, 'metrics.json')),
        ];
    };

    const getRemoveProms = (output: string) => {
        return [
            fs.remove(path.join(output, 'dependencies.json')),
            fs.remove(path.join(output, 'timings.json')),
            fs.remove(path.join(output, 'stats.json')),
            fs.remove(path.join(output, 'metrics.json')),
        ];
    };

    test('It should allow an absolute and relative path', async () => {
        // eslint-disable-next-line global-require
        const { hooks } = require('../outputFiles');
        const output = path.join(__dirname, '/test/');
        await hooks.output.call(
            // eslint-disable-next-line no-console
            { log: console.log, options: { output } },
            {
                report: reportMock,
                metrics: {},
                stats: { toJson: () => ({}) },
            }
        );

        const exists = await Promise.all(getExistsProms(output));

        expect(exists.reduce((prev, curr) => prev && curr, true));

        // Cleaning
        await Promise.all(getRemoveProms(output));
    });
    test('It should allow a relative path', async () => {
        // eslint-disable-next-line global-require
        const { hooks } = require('../outputFiles');
        const output = './test/';
        await hooks.output.call(
            // eslint-disable-next-line no-console
            { log: console.log, options: { output, context: __dirname } },
            {
                report: reportMock,
                metrics: {},
                stats: { toJson: () => ({}) },
            }
        );

        const exists = await Promise.all(getExistsProms(output));

        expect(exists.reduce((prev, curr) => prev && curr, true));

        // Cleaning
        await Promise.all(getRemoveProms(path.join(__dirname, output)));
    });
});
