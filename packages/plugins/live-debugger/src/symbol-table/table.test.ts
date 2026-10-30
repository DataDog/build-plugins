// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { serializeSymbolTable } from './serialize';
import { buildSymbolTable } from './table';
import type { ChunkFunction, ChunkFunctions } from './types';

const DEBUG_ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEBUG_ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// Module paths are relative to the build root, `app` in the repository.
const resolveSourceFile = (modulePath: string) =>
    modulePath.startsWith('../../') ? undefined : `app/${modulePath.replace(/\?.*$/, '')}`;

const getFunction = (
    functionId: string,
    lines: [number, number] | undefined,
    parentIndex?: number,
): ChunkFunction => ({
    functionId,
    parentIndex,
    start: lines ? { line: lines[0], column: 0 } : undefined,
    end: lines ? { line: lines[1], column: 0 } : undefined,
});

const getChunk = (
    debugId: string | undefined,
    functions: ChunkFunction[],
    filepath = 'out.js',
): ChunkFunctions => ({ filepath, debugId, functions });

describe('buildSymbolTable', () => {
    const cases = [
        {
            description: 'list the same function once when several chunks contain it',
            chunks: [
                getChunk(DEBUG_ID_A, [getFunction('src/a.js;add', [1, 3])]),
                getChunk(DEBUG_ID_B, [getFunction('src/a.js;add', [1, 3])]),
            ],
            expected: { functionIds: ['src/a.js;add'] },
        },
        {
            description: 'keep functions that share an ID at different places',
            chunks: [
                getChunk(DEBUG_ID_A, [
                    getFunction('src/a.js;render', [1, 3]),
                    getFunction('src/a.js;render', [5, 7]),
                ]),
            ],
            expected: { functionIds: ['src/a.js;render', 'src/a.js;render'] },
        },
        {
            description: 'leave out functions outside the repository and invalid IDs',
            chunks: [
                getChunk(DEBUG_ID_A, [
                    getFunction('../../shared/a.js;outside', [1, 3]),
                    getFunction('no-separator', [1, 3]),
                    getFunction('src/a.js;inside', [1, 3]),
                ]),
            ],
            expected: {
                functionIds: ['src/a.js;inside'],
                outsideModulePaths: ['../../shared/a.js'],
                invalidFunctionIds: ['no-separator'],
            },
        },
    ];

    test.each(cases)('Should $description.', ({ chunks, expected }) => {
        const result = buildSymbolTable(chunks, resolveSourceFile);
        const functionIds = result.table.entries.map((entry) => entry.functionId);
        const outsideModulePaths = [...result.outsideModulePaths];
        const invalidFunctionIds = [...result.invalidFunctionIds];

        expect(functionIds).toEqual(expected.functionIds);
        expect(outsideModulePaths).toEqual(expected.outsideModulePaths ?? []);
        expect(invalidFunctionIds).toEqual(expected.invalidFunctionIds ?? []);
    });

    test('Should drop copies without a line range when another copy has one.', () => {
        const chunks = [
            getChunk(DEBUG_ID_A, [
                getFunction('src/a.js;outer', undefined),
                getFunction('src/a.js;inner', [2, 4], 0),
            ]),
            getChunk(DEBUG_ID_B, [
                getFunction('src/a.js;outer', [1, 9]),
                getFunction('src/a.js;unmapped', undefined),
            ]),
        ];
        const { table } = buildSymbolTable(chunks, resolveSourceFile);
        const entries = table.entries.map(({ functionId, start, parentKey }) => ({
            functionId,
            located: Boolean(start),
            hasParent: Boolean(parentKey),
        }));

        expect(entries).toEqual([
            { functionId: 'src/a.js;inner', located: true, hasParent: false },
            { functionId: 'src/a.js;outer', located: true, hasParent: false },
            { functionId: 'src/a.js;unmapped', located: false, hasParent: false },
        ]);
    });

    test('Should record which chunks contain each file.', () => {
        const chunks = [
            getChunk(DEBUG_ID_B, [getFunction('src/a.js;add', [1, 3])]),
            getChunk(DEBUG_ID_A, [
                getFunction('src/a.js;add', [1, 3]),
                getFunction('src/b.js;sub', [1, 3]),
            ]),
            getChunk(DEBUG_ID_A, []),
        ];
        const { table } = buildSymbolTable(chunks, resolveSourceFile);
        const fileChunkDebugIds = Object.fromEntries(table.fileChunkDebugIds ?? []);

        expect(table.chunkDebugIds).toEqual([DEBUG_ID_A, DEBUG_ID_B]);
        expect(fileChunkDebugIds).toEqual({
            'app/src/a.js': [DEBUG_ID_A, DEBUG_ID_B],
            'app/src/b.js': [DEBUG_ID_A],
        });
    });

    test('Should leave out chunk debug IDs when a chunk with functions has none.', () => {
        const chunks = [
            getChunk(DEBUG_ID_A, [getFunction('src/a.js;add', [1, 3])]),
            getChunk(undefined, [getFunction('src/b.js;sub', [1, 3])]),
        ];
        const { table } = buildSymbolTable(chunks, resolveSourceFile);

        expect(table.chunkDebugIds).toBeUndefined();
        expect(table.fileChunkDebugIds).toBeUndefined();
    });

    test('Should only nest functions under enclosing functions of the same file.', () => {
        const chunks = [
            getChunk(DEBUG_ID_A, [
                getFunction('src/a.js;outer', [1, 9]),
                // Inlined into `outer` by a minifier.
                getFunction('src/b.js;inlined', [1, 3], 0),
                getFunction('src/a.js;inner', [2, 4], 1),
            ]),
        ];
        const { table } = buildSymbolTable(chunks, resolveSourceFile);
        const [outer, inlined, inner] = table.entries;

        expect(outer.parentKey).toBeUndefined();
        expect(inlined.parentKey).toBeUndefined();
        expect(inner.parentKey).toBe(outer.key);
    });
});

describe('serializeSymbolTable', () => {
    test('Should convert the table to SymDB scopes in source order.', () => {
        const chunks = [
            getChunk(DEBUG_ID_A, [
                getFunction('src/b.js;later', [10, 12]),
                getFunction('src/b.js;outer', [1, 8]),
                getFunction('src/b.js;<anonymous>@3:4:0', [3, 5], 1),
                getFunction('src/a.js;unmapped', undefined),
            ]),
        ];
        const { table } = buildSymbolTable(chunks, resolveSourceFile);

        expect(serializeSymbolTable(table, '1.0.0')).toEqual({
            language: 'browser',
            version: '1.0.0',
            chunk_debug_ids: [DEBUG_ID_A],
            scopes: [
                {
                    scope_type: 'MODULE',
                    name: 'app/src/a.js',
                    source_file: 'app/src/a.js',
                    language_specifics: { chunk_debug_ids: [DEBUG_ID_A] },
                    scopes: [
                        {
                            scope_type: 'FUNCTION',
                            name: 'unmapped',
                            source_file: 'app/src/a.js',
                            language_specifics: { function_id: 'src/a.js;unmapped' },
                        },
                    ],
                },
                {
                    scope_type: 'MODULE',
                    name: 'app/src/b.js',
                    source_file: 'app/src/b.js',
                    language_specifics: { chunk_debug_ids: [DEBUG_ID_A] },
                    scopes: [
                        {
                            scope_type: 'FUNCTION',
                            name: 'outer',
                            source_file: 'app/src/b.js',
                            start_line: 1,
                            end_line: 8,
                            language_specifics: { function_id: 'src/b.js;outer' },
                            scopes: [
                                {
                                    scope_type: 'FUNCTION',
                                    name: '<anonymous>',
                                    source_file: 'app/src/b.js',
                                    start_line: 3,
                                    end_line: 5,
                                    language_specifics: {
                                        function_id: 'src/b.js;<anonymous>@3:4:0',
                                    },
                                },
                            ],
                        },
                        {
                            scope_type: 'FUNCTION',
                            name: 'later',
                            source_file: 'app/src/b.js',
                            start_line: 10,
                            end_line: 12,
                            language_specifics: { function_id: 'src/b.js;later' },
                        },
                    ],
                },
            ],
        });
    });

    test('Should leave out the version and chunk debug IDs when unknown.', () => {
        const chunks = [getChunk(undefined, [getFunction('src/a.js;add', [1, 3])])];
        const { table } = buildSymbolTable(chunks, resolveSourceFile);
        const payload = serializeSymbolTable(table, undefined);

        expect(payload).not.toHaveProperty('version');
        expect(payload).not.toHaveProperty('chunk_debug_ids');
        expect(payload.scopes[0]).not.toHaveProperty('language_specifics');
    });
});
