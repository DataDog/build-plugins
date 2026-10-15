// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { SourcePosition, SymbolTable, SymbolTableEntry } from './types';

// SymDB language of browser symbol tables.
export const SYMBOL_TABLE_LANGUAGE = 'browser';

// A SymDB scope, in the format the backend SDKs upload.
export type SymDbScope = {
    scope_type: 'MODULE' | 'FUNCTION';
    name: string;
    source_file: string;
    start_line?: number;
    end_line?: number;
    language_specifics?: {
        function_id?: string;
        chunk_debug_ids?: string[];
    };
    scopes?: SymDbScope[];
};

// The symbol table in the format of the upload's file part. The upload adds the fields that are
// specific to each request: `service`, `upload_id`, `batch_num` and `final`.
export type SymbolTablePayload = {
    language: typeof SYMBOL_TABLE_LANGUAGE;
    version?: string;
    chunk_debug_ids?: string[];
    scopes: SymDbScope[];
};

const comparePositions = (a: SourcePosition | undefined, b: SourcePosition | undefined) => {
    if (!a || !b) {
        // Functions without a position go last.
        return Number(!a) - Number(!b);
    }
    return a.line - b.line || a.column - b.column;
};

const compareStrings = (a: string, b: string) => (a < b ? -1 : Number(a > b));

// Source order, so enclosing functions come before the functions they contain.
const compareEntries = (a: SymbolTableEntry, b: SymbolTableEntry) =>
    comparePositions(a.start, b.start) ||
    compareStrings(a.functionId, b.functionId) ||
    comparePositions(a.end, b.end);

const toFunctionScope = (
    entry: SymbolTableEntry,
    childrenByParentKey: Map<string, SymbolTableEntry[]>,
): SymDbScope => {
    const children = childrenByParentKey.get(entry.key) ?? [];
    const scope: SymDbScope = {
        scope_type: 'FUNCTION',
        name: entry.name,
        source_file: entry.sourceFile,
    };

    if (entry.start && entry.end) {
        scope.start_line = entry.start.line;
        scope.end_line = entry.end.line;
    }

    scope.language_specifics = { function_id: entry.functionId };

    if (children.length > 0) {
        scope.scopes = children.map((child) => toFunctionScope(child, childrenByParentKey));
    }

    return scope;
};

/**
 * Convert the symbol table to SymDB scopes: one `MODULE` scope per file, without a line range, and
 * one `FUNCTION` scope per function, nested under its enclosing function, in source order.
 */
export const serializeSymbolTable = (
    table: SymbolTable,
    version: string | undefined,
): SymbolTablePayload => {
    const sortedEntries = [...table.entries].sort(compareEntries);
    const topLevelEntriesByFile = new Map<string, SymbolTableEntry[]>();
    const childrenByParentKey = new Map<string, SymbolTableEntry[]>();

    for (const entry of sortedEntries) {
        const siblings = entry.parentKey
            ? childrenByParentKey.get(entry.parentKey) ?? []
            : topLevelEntriesByFile.get(entry.sourceFile) ?? [];
        siblings.push(entry);

        if (entry.parentKey) {
            childrenByParentKey.set(entry.parentKey, siblings);
        } else {
            topLevelEntriesByFile.set(entry.sourceFile, siblings);
        }
    }

    const sourceFiles = [...topLevelEntriesByFile.keys()].sort(compareStrings);
    const scopes = sourceFiles.map((sourceFile): SymDbScope => {
        const topLevelEntries = topLevelEntriesByFile.get(sourceFile) ?? [];
        const chunkDebugIds = table.fileChunkDebugIds?.get(sourceFile);
        const moduleScope: SymDbScope = {
            scope_type: 'MODULE',
            name: sourceFile,
            source_file: sourceFile,
        };

        if (chunkDebugIds) {
            moduleScope.language_specifics = { chunk_debug_ids: chunkDebugIds };
        }

        moduleScope.scopes = topLevelEntries.map((entry) =>
            toFunctionScope(entry, childrenByParentKey),
        );

        return moduleScope;
    });

    return {
        language: SYMBOL_TABLE_LANGUAGE,
        ...(version ? { version } : {}),
        ...(table.chunkDebugIds ? { chunk_debug_ids: table.chunkDebugIds } : {}),
        scopes,
    };
};
