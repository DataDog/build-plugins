// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getPayload, prefixRepeat } from '@dd/error-tracking-plugin/sourcemaps/payload';
import {
    addFixtureFiles,
    getMetadataMock,
    getRepositoryDataMock,
    getSourcemapMock,
} from '@dd/tests/_jest/helpers/mocks';

jest.mock('@dd/core/helpers/fs', () => {
    const original = jest.requireActual('@dd/core/helpers/fs');
    return {
        ...original,
        checkFile: jest.fn(),
        readFileSync: jest.fn(),
    };
});

describe('Error Tracking Plugins Sourcemaps Payloads', () => {
    describe('prefixRepeat', () => {
        test.each([
            { prefix: '/testing/path/to', filePath: '/path/to/file.js', expected: 'path/to' },
            { prefix: '/path/to', filePath: '/to/file.js', expected: 'to' },
            { prefix: '/prefix/ok', filePath: '/path/to/file.js', expected: '' },
            { prefix: '/new/prefix/ok', filePath: '/prefix/to/file.js', expected: '' },
            { prefix: '/', filePath: '/path/to/file.js', expected: '' },
        ])(
            'Should return "$expected" for the prefix "$prefix" and path "$path"',
            ({ prefix, filePath, expected }) => {
                expect(prefixRepeat(filePath, prefix)).toBe(expected);
            },
        );
    });

    describe('getPayload', () => {
        beforeEach(() => {
            // Emulate some fixtures.
            addFixtureFiles({
                '/path/to/minified.min.js': 'Some JS File',
                '/path/to/sourcemap.js.map': '{"version":3,"sources":["/path/to/minified.min.js"]}',
                '/path/to/empty.js': '',
            });
        });

        test('Should add git data if present', async () => {
            const payload = await getPayload(
                getSourcemapMock(),
                getMetadataMock(),
                '/prefix',
                getRepositoryDataMock(),
            );

            expect(payload.content.get('repository')).toMatchObject({
                type: 'string',
                options: {
                    contentType: 'application/json',
                    filename: 'repository',
                },
                value: expect.any(String),
            });

            // No errors and no warnings.
            expect(payload.warnings).toHaveLength(0);
            expect(payload.errors).toHaveLength(0);
        });

        test('Should transfer errors and warnings', async () => {
            const payload = await getPayload(
                getSourcemapMock({
                    sourcemapFilePath: '/path/to/empty.js.map',
                    minifiedFilePath: '/path/to/empty.js',
                }),
                getMetadataMock(),
                '/prefix',
                getRepositoryDataMock(),
            );

            // No errors and no warnings.
            expect(payload.warnings).toHaveLength(1);
            expect(payload.warnings).toEqual([
                'Could not attach git data for sourcemap /path/to/empty.js.map: File not found',
            ]);
            expect(payload.errors).toHaveLength(4);
            expect(payload.errors).toEqual([
                'Minified file is empty: /path/to/empty.js',
                'Minified file not found: /path/to/empty.js',
                'Sourcemap file is empty: /path/to/empty.js.map',
                'Sourcemap file not found: /path/to/empty.js.map',
            ]);
        });

        test('Should have content for the event, the source_map and the minified_file', async () => {
            const payload = await getPayload(
                getSourcemapMock({
                    sourcemapFilePath: '/path/to/sourcemap.js.map',
                    minifiedFilePath: '/path/to/minified.min.js',
                }),
                getMetadataMock(),
                '/prefix',
            );
            expect(payload.content.size).toBe(3);
            expect(payload.content.get('event')).toMatchObject({
                type: 'string',
                options: {
                    contentType: 'application/json',
                    filename: 'event',
                },
                value: expect.any(String),
            });
            expect(payload.content.get('source_map')).toMatchObject({
                type: 'file',
                options: {
                    filename: 'source_map',
                },
                path: '/path/to/sourcemap.js.map',
            });
            expect(payload.content.get('minified_file')).toMatchObject({
                type: 'file',
                options: {
                    filename: 'minified_file',
                },
                path: '/path/to/minified.min.js',
            });

            // No errors and no warnings.
            expect(payload.warnings).toHaveLength(0);
            expect(payload.errors).toHaveLength(0);
        });
    });
});
