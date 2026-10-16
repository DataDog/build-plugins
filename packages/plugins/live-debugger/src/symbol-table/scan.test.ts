// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { readChunkDebugId, scanChunk } from './scan';

const DEBUG_ID = '0f5e4a5c-3b1d-4c8e-9a7f-1b2c3d4e5f60';

describe('scanChunk', () => {
    const cases = [
        {
            description: 'read single, double and backtick quoted function IDs',
            code: `$dd_probes('a.js;one');$dd_throw(p);$dd_probes("a.js;two");$dd_throw(p);$dd_probes(\`a.js;three\`);$dd_throw(p);`,
            expected: {
                functionIds: ['a.js;one', 'a.js;two', 'a.js;three'],
                parentIndexes: [undefined, undefined, undefined],
                paired: true,
            },
        },
        {
            description: 'decode escape sequences',
            code: String.raw`$dd_probes('a.js;it\'s');$dd_throw(p);$dd_probes("a.js;\x41\u0042\u{43}\\");$dd_throw(p);`,
            expected: {
                functionIds: ["a.js;it's", 'a.js;ABC\\'],
                parentIndexes: [undefined, undefined],
                paired: true,
            },
        },
        {
            description: 'nest functions like brackets',
            code: `function a(){let p=$dd_probes('a.js;outer');try{const b=()=>{let q=$dd_probes('a.js;inner');try{}catch(e){$dd_throw(q,e)}};}catch(e){$dd_throw(p,e)}}function c(){let r=$dd_probes('a.js;sibling');try{}catch(e){$dd_throw(r,e)}}`,
            expected: {
                functionIds: ['a.js;outer', 'a.js;inner', 'a.js;sibling'],
                parentIndexes: [undefined, 0, undefined],
                paired: true,
            },
        },
        {
            description: 'accept whitespace around the argument',
            code: `$dd_probes ( 'a.js;spaced' ) ;$dd_throw (p);`,
            expected: {
                functionIds: ['a.js;spaced'],
                parentIndexes: [undefined],
                paired: true,
            },
        },
        {
            description: 'ignore member calls, declarations and non-constant arguments',
            code: `obj.$dd_probes('a.js;member');function $dd_throw(a){}x$dd_probes('a.js;prefixed');$dd_probes(id);$dd_probes(\`a.js;\${name}\`);$dd_probes('a.js;' + name);`,
            expected: {
                functionIds: [],
                parentIndexes: [],
                paired: true,
            },
        },
        {
            description: 'report a closing marker without an opening one',
            code: `$dd_throw(p);$dd_probes('a.js;one');$dd_throw(p);`,
            expected: {
                functionIds: ['a.js;one'],
                parentIndexes: [undefined],
                paired: false,
            },
        },
        {
            description: 'report an opening marker without a closing one',
            code: `$dd_probes('a.js;one');`,
            expected: {
                functionIds: ['a.js;one'],
                parentIndexes: [undefined],
                paired: false,
            },
        },
    ];

    test.each(cases)('Should $description.', ({ code, expected }) => {
        const scan = scanChunk(code);
        const functionIds = scan.functions.map((scanned) => scanned.functionId);
        const parentIndexes = scan.functions.map((scanned) => scanned.parentIndex);

        expect(functionIds).toEqual(expected.functionIds);
        expect(parentIndexes).toEqual(expected.parentIndexes);
        expect(scan.paired).toBe(expected.paired);
    });

    test('Should record the offsets of both markers.', () => {
        const code = `let p=$dd_probes('a.js;one');try{}catch(e){$dd_throw(p,e)}`;
        const [scanned] = scanChunk(code).functions;

        expect(scanned.probeOffset).toBe(code.indexOf('$dd_probes'));
        expect(scanned.throwOffset).toBe(code.indexOf('$dd_throw'));
    });
});

describe('readChunkDebugId', () => {
    const cases = [
        {
            description: 'read the debug ID of the runtime bootstrap',
            code: `globalThis.__DD_LIVE_DEBUGGER_BUILD__={"version":"1.0.0","debugId":"${DEBUG_ID}"}`,
            expected: DEBUG_ID,
        },
        {
            description: 'read the debug ID of a minified runtime bootstrap',
            code: `globalThis.__DD_LIVE_DEBUGGER_BUILD__={version:"1.0.0",debugId:'${DEBUG_ID}'}`,
            expected: DEBUG_ID,
        },
        {
            description: 'return undefined without a debug ID',
            code: `globalThis.__DD_LIVE_DEBUGGER_BUILD__={"version":"1.0.0"}`,
            expected: undefined,
        },
    ];

    test.each(cases)('Should $description.', ({ code, expected }) => {
        expect(readChunkDebugId(code)).toBe(expected);
    });
});
