import { mockReport } from '@datadog/build-plugins-tests/testHelpers';
import type { OutputOptions } from '@dd/telemetry-plugins/types';
import fs from 'fs-extra';
import path from 'path';

describe('Output Files', () => {
    const directoryName = '/test/';
    const init = async (output: OutputOptions, context: string) => {
        const { outputFiles } = require('@dd/telemetry-plugins/common/output/files');
        await outputFiles(
            {
                report: mockReport,
                metrics: {},
                stats: { toJson: () => ({}) },
            },
            { output, context },
        );
    };

    const getExistsProms = (output: string) => {
        return [
            fs.pathExists(path.join(output, 'dependencies.json')),
            fs.pathExists(path.join(output, 'timings.json')),
            fs.pathExists(path.join(output, 'stats.json')),
            fs.pathExists(path.join(output, 'metrics.json')),
        ];
    };

    afterEach(async () => {
        await fs.remove(path.join(__dirname, directoryName));
    });

    describe('With boolean', () => {
        test.each([path.join(__dirname, directoryName), `.${directoryName}`])(
            'It should allow an absolute and relative path',
            async (output) => {
                await init(output, __dirname);
                const exists = await Promise.all(getExistsProms(output));
                expect(exists.reduce((prev, curr) => prev && curr, true));
            },
        );
    });
    describe('With object', () => {
        test('It should output a single file', async () => {
            const output = {
                destination: path.join(__dirname, directoryName),
                timings: true,
            };
            await init(output, __dirname);
            const destination = output.destination;
            const exists = await Promise.all(getExistsProms(destination));

            expect(exists[0]).toBeFalsy();
            expect(exists[1]).toBeTruthy();
            expect(exists[2]).toBeFalsy();
            expect(exists[3]).toBeFalsy();
        });
    });
});
