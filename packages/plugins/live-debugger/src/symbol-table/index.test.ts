// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, rm } from '@dd/core/helpers/fs';
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import { getContextMock, getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import path from 'path';

import type { LiveDebuggerOptionsWithDefaults } from '../types';

import { generateSymbolTable, getUploadSetup, writeSymbolTable } from './index';

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

describe('getUploadSetup', () => {
    const options = {
        version: '1.0.0',
        service: 'shop',
        enableGit: true,
    } satisfies Partial<LiveDebuggerOptionsWithDefaults>;

    const cases = [
        {
            description: 'upload with an API key, a service, a version and git',
            options,
            apiKey: 'api-key',
            expected: {
                settings: {
                    apiKey: 'api-key',
                    site: 'datadoghq.com',
                    service: 'shop',
                    version: '1.0.0',
                },
            },
        },
        {
            description: 'skip without an API key',
            options,
            apiKey: undefined,
            expected: { skipReason: expect.stringContaining('API key') },
        },
        {
            description: 'skip without a service',
            options: { ...options, service: undefined },
            apiKey: 'api-key',
            expected: { skipReason: expect.stringContaining('liveDebugger.service') },
        },
        {
            description: 'skip without a version',
            options: { ...options, version: undefined },
            apiKey: 'api-key',
            expected: { skipReason: expect.stringContaining('metadata.version') },
        },
        {
            description: 'skip when git is disabled',
            options: { ...options, enableGit: false },
            apiKey: 'api-key',
            expected: { skipReason: expect.stringContaining('enableGit') },
        },
    ];

    test.each(cases)('Should $description.', ({ options: pluginOptions, apiKey, expected }) => {
        const context = getContextMock({ auth: { apiKey, site: 'datadoghq.com' } });
        const validatedOptions: LiveDebuggerOptionsWithDefaults = {
            debugId: false,
            include: [],
            exclude: [],
            fileExtensions: 'all',
            honorSkipComments: true,
            functionTypes: undefined,
            namedOnly: false,
            decorators: 'legacy',
            ...pluginOptions,
        };

        expect(getUploadSetup(validatedOptions, context)).toEqual(expected);
    });
});
