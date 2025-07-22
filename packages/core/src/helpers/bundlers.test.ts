// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getAllEntryFiles, getEsbuildEntries, isXpack } from '@dd/core/helpers/bundlers';
import type { BundlerName, ResolvedEntry } from '@dd/core/types';
import {
    addFixtureFiles,
    getContextMock,
    getEsbuildMock,
    mockLogger,
} from '@dd/tests/_jest/helpers/mocks';
import type { BuildOptions } from 'esbuild';
import path from 'path';

jest.mock('glob', () => {
    const originalGlob = jest.requireActual('glob');
    return {
        ...originalGlob,
        glob: {
            sync: jest.fn(),
        },
    };
});

describe('Core Helpers Bundlers', () => {
    describe('getAllEntryFiles', () => {
        beforeEach(() => {
            // Emulate some fixtures.
            addFixtureFiles({
                './fixtures/main.js': '',
                './fixtures/in/main2.js': '',
                './fixtures/in/main3.js': '',
                './fixtures/main4.js': '',
            });
        });

        test.each([
            // No glob pattern
            ['fixtures/main.js', ['fixtures/main.js']],
            // Simple glob pattern
            ['fixtures/*.js', ['fixtures/main4.js', 'fixtures/main.js']],
            // Recursive glob pattern
            [
                'fixtures/**/*.js',
                [
                    'fixtures/main4.js',
                    'fixtures/main.js',
                    'fixtures/in/main3.js',
                    'fixtures/in/main2.js',
                ],
            ],
            // Multiple glob patterns
            ['fixtures/*.js', ['fixtures/main4.js', 'fixtures/main.js']],
            // Non-existent file
            ['fixtures/nonexistent.js', ['fixtures/nonexistent.js']],
        ])('Should return the right files for path "%s"', (filepath, expected) => {
            expect(getAllEntryFiles(filepath)).toEqual(expected);
        });
    });

    describe('getEsbuildEntries', () => {
        let tmpCwd: string = '';
        beforeEach(() => {
            // Emulate some fixtures.
            tmpCwd = addFixtureFiles({
                './fixtures/main.js': '',
                './fixtures/in/main2.js': '',
                './fixtures/in/main3.js': '',
                './fixtures/main4.js': '',
            });
        });

        const expectations: [
            string,
            (cwd: string) => BuildOptions['entryPoints'],
            (cwd: string) => ResolvedEntry[],
        ][] = [
            [
                'Array of strings',
                (cwd) => [path.resolve(cwd, './fixtures/main.js')],
                (cwd) => [
                    {
                        original: path.resolve(cwd, './fixtures/main.js'),
                        resolved: path.resolve(cwd, './fixtures/main.js'),
                    },
                ],
            ],
            [
                'Object with entry names',
                (cwd) => ({
                    app1: path.join(cwd, 'fixtures/main.js'),
                    app2: path.join(cwd, 'fixtures/main4.js'),
                }),
                (cwd) => [
                    {
                        name: 'app1',
                        original: path.join(cwd, 'fixtures/main.js'),
                        resolved: path.join(cwd, 'fixtures/main.js'),
                    },
                    {
                        name: 'app2',
                        original: path.join(cwd, 'fixtures/main4.js'),
                        resolved: path.join(cwd, 'fixtures/main4.js'),
                    },
                ],
            ],
            [
                'Array of objects with in and out',
                () => [
                    {
                        in: 'fixtures/main.js',
                        out: 'outdir/main.js',
                    },
                ],
                (cwd) => [
                    {
                        original: 'fixtures/main.js',
                        resolved: path.join(cwd, 'fixtures/main.js'),
                    },
                ],
            ],
            ['undefined', () => undefined, () => []],
            [
                'Array of strings with glob',
                (cwd) => [path.join(cwd, 'fixtures/*.js')],
                (cwd) => [
                    {
                        original: path.join(cwd, 'fixtures/*.js'),
                        resolved: path.join(cwd, 'fixtures/main4.js'),
                    },
                    {
                        original: path.join(cwd, 'fixtures/*.js'),
                        resolved: path.join(cwd, 'fixtures/main.js'),
                    },
                ],
            ],
            [
                'Object with entry names with glob',
                (cwd) => ({
                    app1: path.join(cwd, 'fixtures/*.js'),
                    app2: path.join(cwd, 'fixtures/**/*.js'),
                }),
                (cwd) => [
                    {
                        name: 'app1',
                        original: path.join(cwd, 'fixtures/*.js'),
                        resolved: path.join(cwd, 'fixtures/main4.js'),
                    },
                    {
                        name: 'app1',
                        original: path.join(cwd, 'fixtures/*.js'),
                        resolved: path.join(cwd, 'fixtures/main.js'),
                    },
                    {
                        name: 'app2',
                        original: path.join(cwd, 'fixtures/**/*.js'),
                        resolved: path.join(cwd, 'fixtures/main4.js'),
                    },
                    {
                        name: 'app2',
                        original: path.join(cwd, 'fixtures/**/*.js'),
                        resolved: path.join(cwd, 'fixtures/main.js'),
                    },
                    {
                        name: 'app2',
                        original: path.join(cwd, 'fixtures/**/*.js'),
                        resolved: path.join(cwd, 'fixtures/in/main3.js'),
                    },
                    {
                        name: 'app2',
                        original: path.join(cwd, 'fixtures/**/*.js'),
                        resolved: path.join(cwd, 'fixtures/in/main2.js'),
                    },
                ],
            ],
            [
                'Array of objects with in and out with globs',
                () => [
                    {
                        in: 'fixtures/*.js',
                        out: 'outdir/main.js',
                    },
                    {
                        in: 'fixtures/main4.js',
                        out: 'outdir/main4.js',
                    },
                ],
                (cwd) => [
                    {
                        original: 'fixtures/*.js',
                        resolved: path.join(cwd, 'fixtures/main4.js'),
                    },
                    {
                        original: 'fixtures/*.js',
                        resolved: path.join(cwd, 'fixtures/main.js'),
                    },
                    {
                        original: 'fixtures/main4.js',
                        resolved: path.join(cwd, 'fixtures/main4.js'),
                    },
                ],
            ],
        ];
        test.each(expectations)(
            'Should return the right map of entrynames for "%s".',
            async (name, getEntryPoints, getEntryNames) => {
                // Need to use a function in order to have the correct `cwd`.
                const entryPoints = getEntryPoints(tmpCwd);
                const entryNames = getEntryNames(tmpCwd);
                const result = await getEsbuildEntries(
                    getEsbuildMock(
                        {
                            initialOptions: {
                                entryPoints,
                            },
                        },
                        tmpCwd,
                    ),
                    getContextMock({ cwd: tmpCwd }),
                    mockLogger,
                );
                expect(result).toEqual(entryNames);
            },
        );
    });

    describe('isXpack', () => {
        test.each([
            ['rspack', true],
            ['webpack', true],
            ['esbuild', false],
            ['rollup', false],
            ['vite', false],
        ])('Should correctly identify xpack bundler "%s" as %s', (bundlerName, expected) => {
            expect(isXpack(bundlerName as BundlerName)).toBe(expected);
        });
    });
});
