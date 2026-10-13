// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { instrument } from '@datadog/js-instrumentation-wasm';
import { LIVE_DEBUGGER_PROBES_FUNCTION } from '@dd/core/constants';

import { buildTransformOptions } from './transform';

const FUNCTION_ID = 'src/utils.js;f';
const PROBE_CALL = `${LIVE_DEBUGGER_PROBES_FUNCTION}('${FUNCTION_ID}')`;

describe('Privacy transform', () => {
    const transformOptions = buildTransformOptions('(v) => v', 'rspack');

    const cases = [
        {
            description: 'a probe call sharing its line with application strings',
            code: `function f(label = 'default') { let p = ${PROBE_CALL}; return label + 'suffix'; }`,
            expected: { keepsProbeCall: true, dictionarySize: 2 },
        },
        {
            description: 'a probe call in a nested function',
            code: `const outer = () => function f() { let p = ${PROBE_CALL}; return 'value'; };`,
            expected: { keepsProbeCall: true, dictionarySize: 1 },
        },
        {
            description: 'a function ID passed to another function',
            code: `function f() { track('${FUNCTION_ID}'); }`,
            expected: { keepsProbeCall: false, dictionarySize: 1 },
        },
    ];

    test.each(cases)(
        'should only skip Live Debugger function IDs for $description',
        ({ code, expected }) => {
            const result = instrument({ id: '/src/utils.js', code }, transformOptions);
            const keepsProbeCall = result.code.includes(PROBE_CALL);

            expect({ keepsProbeCall, dictionarySize: result.privacyDictionarySize }).toEqual(
                expected,
            );
        },
    );
});
