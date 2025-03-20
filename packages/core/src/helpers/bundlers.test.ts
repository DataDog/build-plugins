// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getAllEntryFiles, getEsbuildEntries, isXpack } from '@dd/core/helpers/bundlers';
import type { ResolvedEntry, BundlerFullName } from '@dd/core/types';
import { getContextMock, getEsbuildMock, mockLogger } from '@dd/tests/_jest/helpers/mocks';
import type { BuildOptions } from 'esbuild';
import { vol } from 'memfs';
import path from 'path';

// Use mock files.
jest.mock('fs', () => require('memfs').fs);

describe('Core Helpers Bundlers', () => {
    describe('getAllEntryFiles', () => {
        beforeEach(() => {
            // Emulate some fixtures.
            vol.fromJSON({
                'fixtures/main.js': '',
                'fixtures/in/main2.js': '',
                'fixtures/in/main3.js': '',
                'fixtures/main4.js': '',
            });
        });

        afterEach(() => {
            vol.reset();
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
        beforeEach(() => {
            // Emulate some fixtures.
            vol.fromJSON({
                'fixtures/main.js': '',
                'fixtures/in/main2.js': '',
                'fixtures/in/main3.js': '',
                'fixtures/main4.js': '',
            });
        });

        afterEach(() => {
            vol.reset();
        });

        const expectations: [string, BuildOptions['entryPoints'], ResolvedEntry[]][] = [
            [
                'Array of strings',
                [path.join(process.cwd(), 'fixtures/main.js')],
                [
                    {
                        original: path.join(process.cwd(), 'fixtures/main.js'),
                        resolved: path.join(process.cwd(), 'fixtures/main.js'),
                    },
                ],
            ],
            [
                'Object with entry names',
                {
                    app1: path.join(process.cwd(), 'fixtures/main.js'),
                    app2: path.join(process.cwd(), 'fixtures/main4.js'),
                },
                [
                    {
                        name: 'app1',
                        original: path.join(process.cwd(), 'fixtures/main.js'),
                        resolved: path.join(process.cwd(), 'fixtures/main.js'),
                    },
                    {
                        name: 'app2',
                        original: path.join(process.cwd(), 'fixtures/main4.js'),
                        resolved: path.join(process.cwd(), 'fixtures/main4.js'),
                    },
                ],
            ],
            [
                'Array of objects with in and out',
                [
                    {
                        in: 'fixtures/main.js',
                        out: 'outdir/main.js',
                    },
                ],
                [
                    {
                        original: 'fixtures/main.js',
                        resolved: path.join(process.cwd(), 'fixtures/main.js'),
                    },
                ],
            ],
            ['undefined', undefined, []],
            [
                'Array of strings with glob',
                [path.join(process.cwd(), 'fixtures/*.js')],
                [
                    {
                        original: path.join(process.cwd(), 'fixtures/*.js'),
                        resolved: path.join(process.cwd(), 'fixtures/main4.js'),
                    },
                    {
                        original: path.join(process.cwd(), 'fixtures/*.js'),
                        resolved: path.join(process.cwd(), 'fixtures/main.js'),
                    },
                ],
            ],
            [
                'Object with entry names with glob',
                {
                    app1: path.join(process.cwd(), 'fixtures/*.js'),
                    app2: path.join(process.cwd(), 'fixtures/**/*.js'),
                },
                [
                    {
                        name: 'app1',
                        original: path.join(process.cwd(), 'fixtures/*.js'),
                        resolved: path.join(process.cwd(), 'fixtures/main4.js'),
                    },
                    {
                        name: 'app1',
                        original: path.join(process.cwd(), 'fixtures/*.js'),
                        resolved: path.join(process.cwd(), 'fixtures/main.js'),
                    },
                    {
                        name: 'app2',
                        original: path.join(process.cwd(), 'fixtures/**/*.js'),
                        resolved: path.join(process.cwd(), 'fixtures/main4.js'),
                    },
                    {
                        name: 'app2',
                        original: path.join(process.cwd(), 'fixtures/**/*.js'),
                        resolved: path.join(process.cwd(), 'fixtures/main.js'),
                    },
                    {
                        name: 'app2',
                        original: path.join(process.cwd(), 'fixtures/**/*.js'),
                        resolved: path.join(process.cwd(), 'fixtures/in/main3.js'),
                    },
                    {
                        name: 'app2',
                        original: path.join(process.cwd(), 'fixtures/**/*.js'),
                        resolved: path.join(process.cwd(), 'fixtures/in/main2.js'),
                    },
                ],
            ],
            [
                'Array of objects with in and out with globs',
                [
                    {
                        in: 'fixtures/*.js',
                        out: 'outdir/main.js',
                    },
                    {
                        in: 'fixtures/main4.js',
                        out: 'outdir/main4.js',
                    },
                ],
                [
                    {
                        original: 'fixtures/*.js',
                        resolved: path.join(process.cwd(), 'fixtures/main4.js'),
                    },
                    {
                        original: 'fixtures/*.js',
                        resolved: path.join(process.cwd(), 'fixtures/main.js'),
                    },
                    {
                        original: 'fixtures/main4.js',
                        resolved: path.join(process.cwd(), 'fixtures/main4.js'),
                    },
                ],
            ],
        ];
        test.each(expectations)(
            'Should return the right map of entrynames for "%s".',
            async (name, entryPoints, entryNames) => {
                const result = await getEsbuildEntries(
                    getEsbuildMock({
                        initialOptions: {
                            entryPoints,
                        },
                    }),
                    getContextMock(),
                    mockLogger,
                );
                expect(result).toEqual(entryNames);
            },
        );
    });

    describe('isXpack', () => {
        test.each([
            ['rspack' as BundlerFullName, true],
            ['webpack4' as BundlerFullName, true],
            ['webpack5' as BundlerFullName, true],
            ['webpack' as BundlerFullName, true],
            ['esbuild' as BundlerFullName, false],
            ['rollup' as BundlerFullName, false],
            ['vite' as BundlerFullName, false],
        ])('Should correctly identify xpack bundler "%s" as %s', (bundlerName, expected) => {
            expect(isXpack(bundlerName)).toBe(expected);
        });
    });
});
