// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs-extra';
import path from 'path';

import { mockReport } from '../../__tests__/helpers/testHelpers';
import { OutputOptions } from '../../types';

describe('Output Files', () => {
    const init = async (output: OutputOptions, context: string) => {
        const { hooks } = require('../outputFiles');
        await hooks.output.call(
            // eslint-disable-next-line no-console
            { log: console.log, options: { output, context } },
            {
                report: mockReport,
                metrics: {},
                stats: { toJson: () => ({}) },
            }
        );
    };

    const getExistsProms = async (output: string) => {
        return [
            fs.pathExists(path.join(output, 'dependencies.json')),
            fs.pathExists(path.join(output, 'timings.json')),
            fs.pathExists(path.join(output, 'stats.json')),
            fs.pathExists(path.join(output, 'metrics.json')),
        ];
    };

    afterEach(async () => {
        await fs.remove(path.join(__dirname, '/test/'));
    });

    describe('With boolean', () => {
        test.each([path.join(__dirname, '/test/'), './test/'])(
            'It should allow an absolute and relative path',
            async (output) => {
                await init(output, __dirname);
                const existProms = await getExistsProms(output);
                const exists = await Promise.all(existProms);

                expect(exists.reduce((prev, curr) => prev && curr, true));
            }
        );

        test('It should export hooks', () => {
            const outputFiles = require('../outputFiles');

            expect(typeof outputFiles.hooks).toBe('object');
        });
    });
    describe('With object', () => {
        test('It should output a single file', async () => {
            const output = {
                destination: path.join(__dirname, '/test/'),
                timings: true,
            };
            await init(output, __dirname);
            const destination = output.destination;

            expect(fs.pathExistsSync(path.join(destination, 'dependencies.json'))).toBeFalsy();
            expect(fs.pathExistsSync(path.join(destination, 'timings.json'))).toBeTruthy();
            expect(fs.pathExistsSync(path.join(destination, 'stats.json'))).toBeFalsy();
            expect(fs.pathExistsSync(path.join(destination, 'metrics.json'))).toBeFalsy();
        });
    });
});
