// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, readFile } from '@dd/core/helpers/fs';
import { decodedMappings, TraceMap, traceSegment } from '@jridgewell/trace-mapping';
import type { SourceMapSegment } from '@jridgewell/trace-mapping';
import path from 'path';

import type { ChunkScan } from './scan';
import type { ChunkFunction, SourcePosition } from './types';

const SOURCE_MAPPING_URL_RX = /[#@]\s*sourceMappingURL=(\S+)\s*$/;
const DATA_URL_RX = /^data:[^,]*?(;base64)?,(.*)$/;
// The `sourceMappingURL` comment is at the end of the chunk.
const SOURCE_MAPPING_URL_LOOKBEHIND = 4096;

// Load the chunk's final source map: `<chunk>.map`, or the one its `sourceMappingURL` points to.
export const loadSourceMap = async (
    filepath: string,
    code: string,
): Promise<TraceMap | undefined> => {
    try {
        const siblingMapPath = `${filepath}.map`;
        if (existsSync(siblingMapPath)) {
            const siblingMap = await readFile(siblingMapPath);
            return new TraceMap(siblingMap);
        }

        const tail = code.slice(-SOURCE_MAPPING_URL_LOOKBEHIND);
        const url = SOURCE_MAPPING_URL_RX.exec(tail)?.[1];
        if (!url) {
            return undefined;
        }

        const dataUrl = DATA_URL_RX.exec(url);
        if (dataUrl) {
            const [, base64, payload] = dataUrl;
            const inlineMap = base64
                ? Buffer.from(payload, 'base64').toString('utf-8')
                : decodeURIComponent(payload);
            return new TraceMap(inlineMap);
        }

        const chunkDir = path.dirname(filepath);
        const linkedMapPath = path.resolve(chunkDir, url);
        if (!existsSync(linkedMapPath)) {
            return undefined;
        }
        const linkedMap = await readFile(linkedMapPath);
        return new TraceMap(linkedMap);
    } catch {
        return undefined;
    }
};

// Return a function that converts an offset in `code` to a 1-based line and 0-based column.
const createOffsetConverter = (code: string) => {
    const lineStarts = [0];
    let newline = code.indexOf('\n');
    while (newline !== -1) {
        lineStarts.push(newline + 1);
        newline = code.indexOf('\n', newline + 1);
    }

    return (offset: number): SourcePosition => {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (lineStarts[middle] <= offset) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }

        return { line: low + 1, column: offset - lineStarts[low] };
    };
};

type MappedPosition = SourcePosition & {
    sourceIndex: number;
};

// The original position of the closest segment at or before a generated position, if it's mapped.
const getMappedPosition = (
    traceMap: TraceMap,
    generated: SourcePosition,
): MappedPosition | undefined => {
    const segment = traceSegment(traceMap, generated.line - 1, generated.column);
    if (!segment || segment.length === 1) {
        return undefined;
    }

    return { line: segment[2] + 1, column: segment[3], sourceIndex: segment[1] };
};

// Index of the first segment at or after `column`.
const findSegmentIndex = (segments: readonly SourceMapSegment[], column: number): number => {
    let low = 0;
    let high = segments.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (segments[middle][0] < column) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
};

// The original position of the first mapped segment between two generated positions, both included.
const getFirstMappedPosition = (
    traceMap: TraceMap,
    from: SourcePosition,
    to: SourcePosition,
): MappedPosition | undefined => {
    const lines = decodedMappings(traceMap);

    for (let line = from.line; line <= to.line; line++) {
        const segments = lines[line - 1] ?? [];
        const firstIndex = line === from.line ? findSegmentIndex(segments, from.column) : 0;
        const lastColumn = line === to.line ? to.column : Infinity;

        for (
            let index = firstIndex;
            index < segments.length && segments[index][0] <= lastColumn;
            index++
        ) {
            const segment = segments[index];
            if (segment.length !== 1) {
                return { line: segment[2] + 1, column: segment[3], sourceIndex: segment[1] };
            }
        }
    }

    return undefined;
};

/**
 * The original position of the last mapped segment of `sourceIndex` between two generated
 * positions, both included. Some tokens have no mapping: the code the transform appends after
 * an arrow function's expression body, and tokens that minifiers rewrite. The closest mapped token
 * before the `$dd_throw` call is then the best estimate of where the function ends.
 */
const getLastMappedPosition = (
    traceMap: TraceMap,
    from: SourcePosition,
    to: SourcePosition,
    sourceIndex: number,
): SourcePosition | undefined => {
    const lines = decodedMappings(traceMap);

    for (let line = to.line; line >= from.line; line--) {
        const segments = lines[line - 1] ?? [];
        const lastIndex =
            line === to.line ? findSegmentIndex(segments, to.column + 1) - 1 : segments.length - 1;
        const firstColumn = line === from.line ? from.column : 0;

        for (let index = lastIndex; index >= 0 && segments[index][0] >= firstColumn; index--) {
            const segment = segments[index];
            if (segment.length !== 1 && segment[1] === sourceIndex) {
                return { line: segment[2] + 1, column: segment[3] };
            }
        }
    }

    return undefined;
};

/**
 * Map the scanned functions to their original positions. The transform anchors the `$dd_probes`
 * call to the body's opening brace, and the `$dd_throw` call to its closing brace when the body
 * is a block. When a marker isn't mapped, the closest mapped token inside the function is used.
 */
export const locateFunctions = (
    code: string,
    scan: ChunkScan,
    traceMap: TraceMap | undefined,
): ChunkFunction[] => {
    const toPosition = createOffsetConverter(code);

    return scan.functions.map((scannedFunction) => {
        const { functionId, probeOffset, throwOffset } = scannedFunction;
        const parentIndex = scan.paired ? scannedFunction.parentIndex : undefined;

        if (!traceMap || !scan.paired || throwOffset === undefined) {
            return { functionId, parentIndex, start: undefined, end: undefined };
        }

        const generatedStart = toPosition(probeOffset);
        const generatedEnd = toPosition(throwOffset);
        const mappedStart =
            getMappedPosition(traceMap, generatedStart) ??
            getFirstMappedPosition(traceMap, generatedStart, generatedEnd);
        if (!mappedStart) {
            return { functionId, parentIndex, start: undefined, end: undefined };
        }

        const start = { line: mappedStart.line, column: mappedStart.column };
        const end = getLastMappedPosition(
            traceMap,
            generatedStart,
            generatedEnd,
            mappedStart.sourceIndex,
        );
        if (!end || end.line < start.line) {
            return { functionId, parentIndex, start: undefined, end: undefined };
        }

        return { functionId, parentIndex, start, end };
    });
};
