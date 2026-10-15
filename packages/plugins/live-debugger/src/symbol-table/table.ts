// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parseFunctionId } from '../transform/functionId';

import type {
    ChunkFunction,
    ChunkFunctions,
    SourcePosition,
    SymbolTable,
    SymbolTableEntry,
} from './types';

export type SymbolTableResult = {
    table: SymbolTable;
    // Module paths of functions dropped because they're outside the repository.
    outsideModulePaths: Set<string>;
    // Function IDs that couldn't be parsed.
    invalidFunctionIds: Set<string>;
};

const formatPosition = (position: SourcePosition | undefined) =>
    position ? `${position.line}:${position.column}` : '';

// The same function can be in several chunks, or in several output formats of the same build.
// Functions that share an ID but are at different places are different functions (v1 IDs aren't
// unique), so the key includes the location.
const getEntryKey = (chunkFunction: ChunkFunction, sourceFile: string) => {
    const start = formatPosition(chunkFunction.start);
    const end = formatPosition(chunkFunction.end);
    return [chunkFunction.functionId, sourceFile, start, end].join('\0');
};

// Map the output's chunks to one entry per function, deduplicated across chunks.
export const buildSymbolTable = (
    chunks: ChunkFunctions[],
    resolveSourceFile: (modulePath: string) => string | undefined,
): SymbolTableResult => {
    const entries = new Map<string, SymbolTableEntry>();
    const fileChunkDebugIds = new Map<string, Set<string>>();
    const chunkDebugIds = new Set<string>();
    const outsideModulePaths = new Set<string>();
    const invalidFunctionIds = new Set<string>();
    let hasCompleteDebugIds = true;

    for (const chunk of chunks) {
        if (chunk.debugId) {
            chunkDebugIds.add(chunk.debugId);
        } else if (chunk.functions.length > 0) {
            hasCompleteDebugIds = false;
        }

        // Per function of the chunk, by index.
        const keys: (string | undefined)[] = [];
        const sourceFiles: (string | undefined)[] = [];

        // The closest enclosing function that's in the same file.
        const getParentKey = (chunkFunction: ChunkFunction, sourceFile: string) => {
            let parentIndex = chunkFunction.parentIndex;
            while (parentIndex !== undefined) {
                if (sourceFiles[parentIndex] === sourceFile && keys[parentIndex]) {
                    return keys[parentIndex];
                }
                parentIndex = chunk.functions[parentIndex].parentIndex;
            }
            return undefined;
        };

        for (const chunkFunction of chunk.functions) {
            const parsedId = parseFunctionId(chunkFunction.functionId);
            if (!parsedId) {
                invalidFunctionIds.add(chunkFunction.functionId);
                keys.push(undefined);
                sourceFiles.push(undefined);
                continue;
            }

            const sourceFile = resolveSourceFile(parsedId.modulePath);
            if (!sourceFile) {
                outsideModulePaths.add(parsedId.modulePath);
                keys.push(undefined);
                sourceFiles.push(undefined);
                continue;
            }

            const key = getEntryKey(chunkFunction, sourceFile);
            const parentKey = getParentKey(chunkFunction, sourceFile);
            keys.push(key);
            sourceFiles.push(sourceFile);

            if (chunk.debugId) {
                const debugIds = fileChunkDebugIds.get(sourceFile) ?? new Set();
                debugIds.add(chunk.debugId);
                fileChunkDebugIds.set(sourceFile, debugIds);
            }

            if (!entries.has(key)) {
                entries.set(key, {
                    key,
                    functionId: chunkFunction.functionId,
                    name: parsedId.name,
                    sourceFile,
                    start: chunkFunction.start,
                    end: chunkFunction.end,
                    parentKey,
                });
            }
        }
    }

    const sortedChunkDebugIds = [...chunkDebugIds].sort();
    const sortedFileEntries = [...fileChunkDebugIds].map(([sourceFile, debugIds]) => {
        const sortedDebugIds = [...debugIds].sort();
        return [sourceFile, sortedDebugIds] as const;
    });
    const sortedFileChunkDebugIds = new Map(sortedFileEntries);

    // Never publish incomplete chunk membership.
    const table: SymbolTable = {
        entries: [...entries.values()],
        chunkDebugIds: hasCompleteDebugIds ? sortedChunkDebugIds : undefined,
        fileChunkDebugIds: hasCompleteDebugIds ? sortedFileChunkDebugIds : undefined,
    };

    return { table, outsideModulePaths, invalidFunctionIds };
};
