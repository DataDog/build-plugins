// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, rm } from '@dd/core/helpers/fs';
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import path from 'path';

import { generateSymbolTable, writeSymbolTable } from './index';

const PAYLOAD = { language: 'browser' as const, scopes: [] };

describe('Live Debugger symbol table', () => {
    let workingDir: string;

    beforeEach(() => {
        const seed = `${Math.abs(jest.getSeed())}.symbol-table-unit.${Date.now()}`;
        workingDir = getTempWorkingDir(seed);
    });

    afterEach(async () => {
        await rm(workingDir);
    });

    test('Should not write the dump inside the output directory.', async () => {
        const outDir = path.resolve(workingDir, 'dist');
        const dumpPath = path.resolve(outDir, 'symbol-table.json');

        await writeSymbolTable(PAYLOAD, dumpPath, outDir, getMockLogger());

        expect(existsSync(dumpPath)).toBe(false);
        expect(mockLogFn).toHaveBeenCalledWith(
            expect.stringContaining('inside the output directory'),
            'warn',
        );
    });

    test('Should write the dump outside the output directory.', async () => {
        const outDir = path.resolve(workingDir, 'dist');
        const dumpPath = path.resolve(workingDir, 'symbol-table.json');

        await writeSymbolTable(PAYLOAD, dumpPath, outDir, getMockLogger());

        expect(existsSync(dumpPath)).toBe(true);
    });

    test('Should skip the table outside a git repository.', async () => {
        const table = await generateSymbolTable({
            outputs: [],
            buildRoot: workingDir,
            log: getMockLogger(),
        });

        expect(table).toBeUndefined();
        expect(mockLogFn).toHaveBeenCalledWith(
            expect.stringContaining("isn't in a git repository"),
            'warn',
        );
    });
});
