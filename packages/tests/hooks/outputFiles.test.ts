// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs-extra';
import path from 'path';

import { mockReport } from '@datadog/build-plugins-tests/testHelpers';
import { OutputOptions } from '@datadog/build-plugins-core/types';

describe('Output Files', () => {
    const directoryName = '/test/';
    const init = async (output: OutputOptions, context: string) => {
        const { hooks } = require('@datadog/build-plugins-hooks/outputFiles');
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
            }
        );

        test('It should export hooks', () => {
            const outputFiles = require('@datadog/build-plugins-hooks/outputFiles');

            expect(typeof outputFiles.hooks).toBe('object');
        });
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
