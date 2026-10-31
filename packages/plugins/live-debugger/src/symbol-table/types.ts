// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// A position in an original source file: 1-based line, 0-based column.
export type SourcePosition = {
    line: number;
    column: number;
};

// An instrumented function found in an emitted chunk.
export type ChunkFunction = {
    functionId: string;
    // Index of the enclosing instrumented function in the same chunk.
    parentIndex: number | undefined;
    // Original positions of the function body's opening and closing brace.
    // Both are undefined when either one can't be mapped.
    start: SourcePosition | undefined;
    end: SourcePosition | undefined;
};

export type ChunkFunctions = {
    filepath: string;
    // Undefined when the chunk has no debug ID.
    debugId: string | undefined;
    functions: ChunkFunction[];
};

export type SymbolTableEntry = {
    // Identifies the entry: the same function in several chunks has the same key.
    key: string;
    functionId: string;
    name: string;
    // Path relative to the repository root.
    sourceFile: string;
    start: SourcePosition | undefined;
    end: SourcePosition | undefined;
    // Key of the enclosing function's entry, when it's in the same file.
    parentKey: string | undefined;
};

export type SymbolTable = {
    entries: SymbolTableEntry[];
    // Debug IDs of the build's chunks. Undefined when a chunk with instrumented functions has none.
    chunkDebugIds: string[] | undefined;
    // For each source file, the debug IDs of the chunks that contain its functions.
    // Undefined in the same case as `chunkDebugIds`.
    fileChunkDebugIds: Map<string, string[]> | undefined;
};
