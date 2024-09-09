// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFiles } from '@dd/telemetry-plugins/common/output/files';
import type { OutputOptions } from '@dd/telemetry-plugins/types';
import { mockLogger, mockReport } from '@dd/tests/plugins/telemetry/testHelpers';
import fs from 'fs-extra';
import { vol } from 'memfs';
import path from 'path';

jest.mock('fs', () => require('memfs').fs);

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

    const getExists = (output: string) => {
        return [
            fs.pathExistsSync(path.join(output, 'timings.json')),
            fs.pathExistsSync(path.join(output, 'metrics.json')),
        ];
    };

    afterEach(() => {
        vol.reset();
    });

    describe('With strings', () => {
        test.each([
            { type: 'an absolue', dirPath: path.join(__dirname, directoryName) },
            { type: 'a relative', dirPath: `.${directoryName}` },
        ])('It should allow $type path', async ({ type, dirPath }) => {
            await init(dirPath, __dirname);
            const absolutePath = type === 'an absolue' ? dirPath : path.resolve(__dirname, dirPath);
            const exists = getExists(absolutePath);

            expect(exists[0]).toBeTruthy();
            expect(exists[1]).toBeTruthy();
        });
    });

    describe('With booleans', () => {
        test('It should output all the files with true.', async () => {
            await init(true, __dirname);
            const exists = getExists(__dirname);

            expect(exists[0]).toBeTruthy();
            expect(exists[1]).toBeTruthy();
        });
        test('It should output no files with false.', async () => {
            await init(false, __dirname);
            const exists = getExists(__dirname);

            expect(exists[0]).toBeFalsy();
            expect(exists[1]).toBeFalsy();
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
            const exists = getExists(destination);

            expect(exists[0]).toBeTruthy();
            expect(exists[1]).toBeFalsy();
        });
    });
});
