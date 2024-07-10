// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { checkFile, getPayload, prefixRepeat } from '@dd/rum-plugins/sourcemaps/payload';
import { vol } from 'memfs';
import path from 'path';

import { getMetadataMock, getRepositoryDataMock, getSourcemapMock } from '../testHelpers';

jest.mock('fs', () => require('memfs').fs);

describe('RUM Plugins Sourcemaps Payloads', () => {
    describe('prefixRepeat', () => {
        test.each([
            { prefix: '/testing/path/to', filePath: '/path/to/file.js', expected: 'path/to' },
            { prefix: '/path/to', filePath: '/to/file.js', expected: 'to' },
            { prefix: '/prefix/ok', filePath: '/path/to/file.js', expected: '' },
            { prefix: '/new/prefix/ok', filePath: '/prefix/to/file.js', expected: '' },
            { prefix: '/', filePath: '/path/to/file.js', expected: '' },
        ])(
            'It should return "$expected" for the prefix "$prefix" and path "$path"',
            ({ prefix, filePath, expected }) => {
                expect(prefixRepeat(filePath, prefix)).toBe(expected);
            },
        );
    });

    describe('checkFile', () => {
        beforeEach(() => {
            // Emulate some fixtures.
            vol.fromJSON(
                {
                    'fixtures/empty.js': '',
                    'fixtures/not-empty.js': 'Not empty file',
                },
                __dirname,
            );
        });

        afterEach(() => {
            vol.reset();
        });
        test.each([
            { filePath: 'fixtures/not-empty.js', expected: { exists: true, empty: false } },
            { filePath: 'fixtures/empty.js', expected: { exists: true, empty: true } },
            { filePath: 'fixtures/not-exist.js', expected: { exists: false, empty: false } },
        ])(
            'It should return "$expected" for the file "$filePath".',
            async ({ filePath, expected }) => {
                const validity = await checkFile(path.resolve(__dirname, filePath));
                expect(validity).toEqual(expected);
            },
        );
    });

    describe('getPayload', () => {
        beforeEach(() => {
            // Emulate some fixtures.
            vol.fromJSON(
                {
                    '/path/to/minified.min.js': 'Some JS File',
                    '/path/to/sourcemap.js.map':
                        '{"version":3,"sources":["/path/to/minified.min.js"]}',
                    '/path/to/empty.js': '',
                },
                __dirname,
            );
        });

        afterEach(() => {
            vol.reset();
        });

        test('It should add git data if present', async () => {
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
            expect(payload.warnings.length).toBe(0);
            expect(payload.errors.length).toBe(0);
        });
        test('It should transfer errors and warnings', async () => {});
        test('It should have content for the event, the source_map and the minified_file', async () => {
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
            expect(payload.warnings.length).toBe(0);
            expect(payload.errors.length).toBe(0);
        });
    });
});
