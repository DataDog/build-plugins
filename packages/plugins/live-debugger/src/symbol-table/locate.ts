// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, readFile } from '@dd/core/helpers/fs';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
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

const getOriginalPosition = (
    traceMap: TraceMap,
    generated: SourcePosition,
): SourcePosition | undefined => {
    const original = originalPositionFor(traceMap, generated);
    if (original.line === null || original.column === null) {
        return undefined;
    }

    return { line: original.line, column: original.column };
};

/**
 * Map the scanned functions to their original positions. The transform anchors the `$dd_probes`
 * call to the body's opening brace and the `$dd_throw` call to its closing brace.
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
        const start = getOriginalPosition(traceMap, generatedStart);
        const end = getOriginalPosition(traceMap, generatedEnd);
        if (!start || !end || end.line < start.line) {
            return { functionId, parentIndex, start: undefined, end: undefined };
        }

        return { functionId, parentIndex, start, end };
    });
};
