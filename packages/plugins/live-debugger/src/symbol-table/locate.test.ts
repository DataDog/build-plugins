// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { SourceMapSegment } from '@jridgewell/trace-mapping';
import { TraceMap } from '@jridgewell/trace-mapping';

import { locateFunctions } from './locate';
import { scanChunk } from './scan';

// A minified function: `body` stands for the original code of its body.
const CODE = `let p=$dd_probes('a.js;fn');try{body}catch(e){throw p&&$dd_throw(p,e),e}`;
const PROBE = CODE.indexOf('$dd_probes');
const BODY = CODE.indexOf('body');
const THROW = CODE.indexOf('$dd_throw');
const CATCH = CODE.indexOf('catch');

// Segments map a generated column to `[source, original line (0-based), original column]`,
// or to nothing.
type Mapping = [column: number, source?: number, line?: number];

const getTraceMap = (mappings: Mapping[]) => {
    const segments = mappings.map(([column, source, line]): SourceMapSegment => {
        if (source === undefined || line === undefined) {
            return [column];
        }
        return [column, source, line, 0];
    });

    return new TraceMap({
        version: 3,
        sources: ['a.js', 'b.js'],
        names: [],
        mappings: [segments],
    });
};

describe('locateFunctions', () => {
    const cases = [
        {
            description: 'use the original positions of both markers',
            mappings: [
                [PROBE, 0, 0],
                [BODY, 0, 1],
                [THROW, 0, 4],
            ],
            expected: { start: 1, end: 5 },
        },
        {
            description: 'end at the last mapped token when the closing marker is not mapped',
            mappings: [[PROBE, 0, 0], [BODY, 0, 2], [THROW - 8], [THROW]],
            expected: { start: 1, end: 3 },
        },
        {
            description: 'start at the first mapped token when the opening marker is not mapped',
            mappings: [[0], [PROBE], [BODY, 0, 6], [THROW, 0, 8]],
            expected: { start: 7, end: 9 },
        },
        {
            description: 'ignore tokens of another source when looking for the end',
            mappings: [[PROBE, 0, 0], [BODY, 0, 2], [CATCH, 1, 40], [THROW]],
            expected: { start: 1, end: 3 },
        },
        {
            description: 'leave out positions when nothing in the function is mapped',
            mappings: [[0], [PROBE], [THROW]],
            expected: undefined,
        },
    ] satisfies { description: string; mappings: Mapping[]; expected: unknown }[];

    test.each(cases)('Should $description.', ({ mappings, expected }) => {
        const traceMap = getTraceMap(mappings);
        const scan = scanChunk(CODE);
        const [located] = locateFunctions(CODE, scan, traceMap);
        const lines = located.start &&
            located.end && {
                start: located.start.line,
                end: located.end.line,
            };

        expect(lines).toEqual(expected);
    });

    test('Should leave out positions without a source map.', () => {
        const scan = scanChunk(CODE);
        const [located] = locateFunctions(CODE, scan, undefined);

        expect(located).toEqual({
            functionId: 'a.js;fn',
            parentIndex: undefined,
            start: undefined,
            end: undefined,
        });
    });
});
