// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFiles } from '@dd/telemetry-plugins/common/output/files';
import type { OutputOptions } from '@dd/telemetry-plugins/types';
import { mockLogger, mockReport } from '@dd/tests/plugins/telemetry/testHelpers';
import { vol } from 'memfs';
import path from 'path';

jest.mock('fs', () => require('memfs').fs);
jest.mock('fs/promises', () => require('memfs').fs.promises);

describe('Telemetry Output Files', () => {
    const directoryName = '/test/';
    const init = async (output: OutputOptions, cwd: string) => {
        await outputFiles(
            {
                report: mockReport,
                metrics: [],
            },
            output,
            mockLogger,
            cwd,
        );
    };

    afterEach(() => {
        vol.reset();
    });

    describe('With strings', () => {
        test.each([
            { type: 'an absolute', dirPath: path.join(__dirname, directoryName) },
            { type: 'a relative', dirPath: `.${directoryName}` },
        ])('Should allow $type path', async ({ type, dirPath }) => {
            await init(dirPath, __dirname);
            const absolutePath =
                type === 'an absolute' ? dirPath : path.resolve(__dirname, dirPath);

            expect(vol.existsSync(path.join(absolutePath, 'timings.json'))).toBeTruthy();
            expect(vol.existsSync(path.join(absolutePath, 'metrics.json'))).toBeTruthy();
        });
    });

    describe('With booleans', () => {
        test('Should output all the files with true.', async () => {
            await init(true, __dirname);

            expect(vol.existsSync(path.join(__dirname, 'timings.json'))).toBeTruthy();
            expect(vol.existsSync(path.join(__dirname, 'metrics.json'))).toBeTruthy();
        });
        test('Should output no files with false.', async () => {
            await init(false, __dirname);

            expect(vol.existsSync(path.join(__dirname, 'timings.json'))).toBeFalsy();
            expect(vol.existsSync(path.join(__dirname, 'metrics.json'))).toBeFalsy();
        });
    });

    describe('With object', () => {
        test('Should output a single file', async () => {
            const output = {
                destination: path.join(__dirname, directoryName),
                timings: true,
            };
            await init(output, __dirname);
            const destination = output.destination;

            expect(vol.existsSync(path.join(destination, 'timings.json'))).toBeTruthy();
            expect(vol.existsSync(path.join(destination, 'metrics.json'))).toBeFalsy();
        });
    });
});
