// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputJson } from '@dd/core/helpers/fs';
import { outputFiles } from '@dd/telemetry-plugin/common/output/files';
import type { OutputOptions } from '@dd/telemetry-plugin/types';
import { mockLogger, mockReport } from '@dd/tests/_jest/helpers/mocks';
import path from 'path';

jest.mock('@dd/core/helpers/fs', () => {
    const original = jest.requireActual('@dd/core/helpers/fs');
    return {
        ...original,
        outputJson: jest.fn(),
    };
});

const mockOutputJson = jest.mocked(outputJson);

describe('Telemetry Output Files', () => {
    const directoryName = '/test/';
    const init = async (output: OutputOptions, cwd: string) => {
        await outputFiles(
            {
                report: mockReport,
                metrics: new Set(),
            },
            output,
            mockLogger,
            cwd,
        );
    };

    describe('With strings', () => {
        test.each([
            { type: 'an absolute', dirPath: path.join(__dirname, directoryName) },
            { type: 'a relative', dirPath: `.${directoryName}` },
        ])('Should allow $type path', async ({ type, dirPath }) => {
            await init(dirPath, __dirname);
            const absolutePath =
                type === 'an absolute' ? dirPath : path.resolve(__dirname, dirPath);

            expect(mockOutputJson).toHaveBeenCalledTimes(2);
            expect(mockOutputJson).toHaveBeenCalledWith(
                path.join(absolutePath, 'timings.json'),
                expect.any(Object),
            );
            expect(mockOutputJson).toHaveBeenCalledWith(
                path.join(absolutePath, 'metrics.json'),
                expect.any(Object),
            );
        });
    });

    describe('With booleans', () => {
        test('Should output all the files with true.', async () => {
            await init(true, __dirname);

            expect(mockOutputJson).toHaveBeenCalledTimes(2);
            expect(mockOutputJson).toHaveBeenCalledWith(
                path.join(__dirname, 'timings.json'),
                expect.any(Object),
            );
            expect(mockOutputJson).toHaveBeenCalledWith(
                path.join(__dirname, 'metrics.json'),
                expect.any(Object),
            );
        });
        test('Should output no files with false.', async () => {
            await init(false, __dirname);
            expect(mockOutputJson).toHaveBeenCalledTimes(0);
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

            expect(mockOutputJson).toHaveBeenCalledTimes(1);
            expect(mockOutputJson).toHaveBeenCalledWith(
                path.join(destination, 'timings.json'),
                expect.any(Object),
            );
        });
    });
});
