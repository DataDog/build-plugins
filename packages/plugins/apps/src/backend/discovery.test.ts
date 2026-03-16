// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { discoverBackendFunctions } from '@dd/apps-plugin/backend/discovery';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import fs from 'fs';
import path from 'path';

const log = getMockLogger();
const backendDir = '/project/backend';

const fileStat = { isDirectory: () => false, isFile: () => true };
const dirStat = { isDirectory: () => true, isFile: () => false };

describe('Backend Functions - discoverBackendFunctions', () => {
    let readdirSpy: jest.SpyInstance;
    let statSpy: jest.SpyInstance;

    beforeEach(() => {
        readdirSpy = jest.spyOn(fs, 'readdirSync');
        statSpy = jest.spyOn(fs, 'statSync');
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('file discovery', () => {
        const cases = [
            {
                description: 'discover a single .ts file',
                entries: ['handler.ts'],
                stats: { [path.join(backendDir, 'handler.ts')]: fileStat },
                expected: [{ name: 'handler', entryPath: path.join(backendDir, 'handler.ts') }],
            },
            {
                description: 'discover a single .js file',
                entries: ['handler.js'],
                stats: { [path.join(backendDir, 'handler.js')]: fileStat },
                expected: [{ name: 'handler', entryPath: path.join(backendDir, 'handler.js') }],
            },
            {
                description: 'discover a directory with index.ts',
                entries: ['myFunc'],
                stats: {
                    [path.join(backendDir, 'myFunc')]: dirStat,
                    [path.join(backendDir, 'myFunc', 'index.ts')]: fileStat,
                },
                expected: [
                    {
                        name: 'myFunc',
                        entryPath: path.join(backendDir, 'myFunc', 'index.ts'),
                    },
                ],
            },
            {
                description: 'discover multiple functions (mix of files and directories)',
                entries: ['handler.ts', 'myFunc'],
                stats: {
                    [path.join(backendDir, 'handler.ts')]: fileStat,
                    [path.join(backendDir, 'myFunc')]: dirStat,
                    [path.join(backendDir, 'myFunc', 'index.ts')]: fileStat,
                },
                expected: [
                    { name: 'handler', entryPath: path.join(backendDir, 'handler.ts') },
                    {
                        name: 'myFunc',
                        entryPath: path.join(backendDir, 'myFunc', 'index.ts'),
                    },
                ],
            },
            {
                description: 'skip non-matching extensions',
                entries: ['config.json', 'styles.css', 'handler.ts'],
                stats: {
                    [path.join(backendDir, 'config.json')]: fileStat,
                    [path.join(backendDir, 'styles.css')]: fileStat,
                    [path.join(backendDir, 'handler.ts')]: fileStat,
                },
                expected: [{ name: 'handler', entryPath: path.join(backendDir, 'handler.ts') }],
            },
            {
                description: 'skip directory with no valid index file',
                entries: ['emptyDir'],
                stats: {
                    [path.join(backendDir, 'emptyDir')]: dirStat,
                },
                expected: [],
            },
            {
                description: 'return empty array for empty directory',
                entries: [],
                stats: {},
                expected: [],
            },
        ];

        test.each(cases)('Should $description', ({ entries, stats, expected }) => {
            readdirSpy.mockReturnValue(entries);
            statSpy.mockImplementation((p: string) => {
                const stat = stats[p];
                if (!stat) {
                    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
                }
                return stat;
            });

            const result = discoverBackendFunctions(backendDir, log);
            expect(result).toEqual(expected);
        });
    });

    describe('error handling', () => {
        test('Should return empty array and log debug when directory does not exist', () => {
            readdirSpy.mockImplementation(() => {
                throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            });

            const result = discoverBackendFunctions('/nonexistent', log);
            expect(result).toEqual([]);
            expect(mockLogFn).toHaveBeenCalledWith(
                expect.stringContaining('No backend directory found'),
                'debug',
            );
        });

        test('Should rethrow non-ENOENT errors', () => {
            readdirSpy.mockImplementation(() => {
                throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
            });

            expect(() => discoverBackendFunctions(backendDir, log)).toThrow('EACCES');
        });
    });

    describe('extension priority', () => {
        test('Should prefer .ts over .js for directory index', () => {
            readdirSpy.mockReturnValue(['myFunc']);
            statSpy.mockImplementation((p) => {
                if (p === path.join(backendDir, 'myFunc')) {
                    return dirStat;
                }
                if (p === path.join(backendDir, 'myFunc', 'index.ts')) {
                    return fileStat;
                }
                throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            });

            const result = discoverBackendFunctions(backendDir, log);
            expect(result).toEqual([
                {
                    name: 'myFunc',
                    entryPath: path.join(backendDir, 'myFunc', 'index.ts'),
                },
            ]);
        });
    });
});
