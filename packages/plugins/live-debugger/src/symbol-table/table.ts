// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { isOutsideRoot } from '../paths';
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
// IDs are only unique within a module, and modules of the same file, such as a file imported with
// different queries, can share IDs. Functions that share an ID but are at different places are
// different functions, so the key includes the location.
const getEntryKey = (chunkFunction: ChunkFunction, sourceFile: string) => {
    const start = formatPosition(chunkFunction.start);
    const end = formatPosition(chunkFunction.end);
    return [chunkFunction.functionId, sourceFile, start, end].join('\0');
};

// In some chunks a copy of a function can't be mapped, while other copies can. A copy without a
// line range then adds nothing, so drop it and attach its children to its own parent.
const removeUnlocatedCopies = (entries: SymbolTableEntry[]): SymbolTableEntry[] => {
    const getFunctionKey = (entry: SymbolTableEntry) => `${entry.functionId}\0${entry.sourceFile}`;
    const locatedEntries = entries.filter((entry) => entry.start);
    const locatedFunctionKeys = new Set(locatedEntries.map(getFunctionKey));
    const removedParentKeys = new Map<string, string | undefined>();

    const keptEntries = entries.filter((entry) => {
        const functionKey = getFunctionKey(entry);
        if (entry.start || !locatedFunctionKeys.has(functionKey)) {
            return true;
        }
        removedParentKeys.set(entry.key, entry.parentKey);
        return false;
    });

    const getKeptParentKey = (parentKey: string | undefined) => {
        let keptParentKey = parentKey;
        while (keptParentKey !== undefined && removedParentKeys.has(keptParentKey)) {
            keptParentKey = removedParentKeys.get(keptParentKey);
        }
        return keptParentKey;
    };

    return keptEntries.map((entry) => {
        const parentKey = getKeptParentKey(entry.parentKey);
        return { ...entry, parentKey };
    });
};

// Map the output's chunks to one entry per function, deduplicated across chunks.
export const buildSymbolTable = (chunks: ChunkFunctions[]): SymbolTableResult => {
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

            // The transform makes the path relative to the repository root.
            const sourceFile = parsedId.modulePath;
            if (isOutsideRoot(sourceFile)) {
                outsideModulePaths.add(sourceFile);
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
    const allEntries = [...entries.values()];
    const table: SymbolTable = {
        entries: removeUnlocatedCopies(allEntries),
        chunkDebugIds: hasCompleteDebugIds ? sortedChunkDebugIds : undefined,
        fileChunkDebugIds: hasCompleteDebugIds ? sortedFileChunkDebugIds : undefined,
    };

    return { table, outsideModulePaths, invalidFunctionIds };
};
