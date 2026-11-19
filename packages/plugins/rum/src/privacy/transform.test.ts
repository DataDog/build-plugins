// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { instrument } from '@datadog/js-instrumentation-wasm';
import { LIVE_DEBUGGER_CATCH_FUNCTION, LIVE_DEBUGGER_PROBES_FUNCTION } from '@dd/core/constants';

import { buildTransformOptions } from './transform';

const FUNCTION_ID = 'src/utils.js;f';
const PROBE_CALL = `${LIVE_DEBUGGER_PROBES_FUNCTION}('${FUNCTION_ID}')`;
const CATCH_CALL = `${LIVE_DEBUGGER_CATCH_FUNCTION}('${FUNCTION_ID}', e, this)`;

describe('Privacy transform', () => {
    const transformOptions = buildTransformOptions('(v) => v', 'rspack');

    const cases = [
        {
            description: 'a probe call sharing its line with application strings',
            code: `function f(label = 'default') { let p = ${PROBE_CALL}; return label + 'suffix'; }`,
            expected: { keepsProbeCall: true, keepsCatchCall: false, dictionarySize: 2 },
        },
        {
            description: 'a probe call in a nested function',
            code: `const outer = () => function f() { let p = ${PROBE_CALL}; return 'value'; };`,
            expected: { keepsProbeCall: true, keepsCatchCall: false, dictionarySize: 1 },
        },
        {
            description: 'an Exception Replay catch hook call',
            code: `function f() { try { return 'value'; } catch (e) { ${CATCH_CALL}; throw e; } }`,
            expected: { keepsProbeCall: false, keepsCatchCall: true, dictionarySize: 1 },
        },
        {
            description: 'a function ID passed to another function',
            code: `function f() { track('${FUNCTION_ID}'); }`,
            expected: { keepsProbeCall: false, keepsCatchCall: false, dictionarySize: 1 },
        },
    ];

    test.each(cases)(
        'should only skip Live Debugger function IDs for $description',
        ({ code, expected }) => {
            const result = instrument({ id: '/src/utils.js', code }, transformOptions);
            const keepsProbeCall = result.code.includes(PROBE_CALL);
            const keepsCatchCall = result.code.includes(CATCH_CALL);

            expect({
                keepsProbeCall,
                keepsCatchCall,
                dictionarySize: result.privacyDictionarySize,
            }).toEqual(expected);
        },
    );
});
