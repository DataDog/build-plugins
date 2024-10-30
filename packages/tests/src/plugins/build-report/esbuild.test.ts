// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getEntryNames } from '@dd/internal-build-report-plugin/esbuild';
import { getContextMock } from '@dd/tests/helpers/mocks';
import { vol } from 'memfs';
import path from 'path';

jest.mock('fs', () => require('memfs').fs);

describe('Build report plugin esbuild', () => {
    describe('getEntrynames', () => {
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
        const expectations: [string, Parameters<typeof getEntryNames>[0], Map<string, string>][] = [
            [
                'Array of strings',
                [path.join(process.cwd(), 'fixtures/main.js')],
                new Map([['fixtures/main.js', 'fixtures/main.js']]),
            ],
            [
                'Object with entry names',
                {
                    app1: path.join(process.cwd(), 'fixtures/main.js'),
                    app2: path.join(process.cwd(), 'fixtures/main4.js'),
                },
                new Map([
                    ['fixtures/main.js', 'app1'],
                    ['fixtures/main4.js', 'app2'],
                ]),
            ],
            [
                'Array of objects with in and out',
                [
                    {
                        in: 'fixtures/main.js',
                        out: 'outdir/main.js',
                    },
                ],
                new Map([['fixtures/main.js', 'fixtures/main.js']]),
            ],
            ['undefined', undefined, new Map()],
            [
                'Array of strings with glob',
                [path.join(process.cwd(), 'fixtures/*.js')],
                new Map([
                    ['fixtures/main.js', 'fixtures/main.js'],
                    ['fixtures/main4.js', 'fixtures/main4.js'],
                ]),
            ],
            [
                'Object with entry names with glob',
                {
                    app1: path.join(process.cwd(), 'fixtures/*.js'),
                    app2: path.join(process.cwd(), 'fixtures/**/*.js'),
                },
                new Map([
                    ['fixtures/main.js', 'app1'],
                    ['fixtures/in/main2.js', 'app2'],
                    ['fixtures/in/main3.js', 'app2'],
                    ['fixtures/main.js', 'app2'],
                    // We expect the latest entry to take precendence.
                    ['fixtures/main4.js', 'app2'],
                ]),
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
                new Map([
                    ['fixtures/main.js', 'fixtures/main.js'],
                    ['fixtures/main4.js', 'fixtures/main4.js'],
                ]),
            ],
        ];
        test.each(expectations)(
            'Should return the right map of entrynames for "%s".',
            (name, entryPoints, entryNames) => {
                const result = getEntryNames(
                    entryPoints,
                    getContextMock({
                        cwd: process.cwd(),
                        bundler: {
                            name: 'esbuild',
                            fullName: 'esbuild',
                            outDir: path.join(process.cwd(), 'outdir'),
                            version: '1.0.0',
                        },
                    }),
                );
                expect(result).toEqual(entryNames);
            },
        );
    });
});
