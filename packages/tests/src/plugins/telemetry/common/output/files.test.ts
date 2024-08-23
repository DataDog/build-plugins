// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFiles } from '@dd/telemetry-plugins/common/output/files';
import type { OutputOptions } from '@dd/telemetry-plugins/types';
import { mockLogger, mockReport } from '@dd/tests/plugins/telemetry/testHelpers';
import fs from 'fs-extra';
import path from 'path';

describe('Telemetry Output Files', () => {
    const directoryName = '/test/';
    const init = async (output: OutputOptions, cwd: string) => {
        await outputFiles(
            {
                start: 0,
                report: mockReport,
                metrics: [],
            },
            output,
            mockLogger,
            cwd,
        );
    };

    const getExistsProms = (output: string) => {
        return [
            fs.pathExists(path.join(output, 'dependencies.json')),
            fs.pathExists(path.join(output, 'timings.json')),
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
            expect(exists[3]).toBeFalsy();
        });
    });
});
