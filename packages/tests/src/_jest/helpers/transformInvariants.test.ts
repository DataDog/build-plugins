// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    annotateCalls,
    countAnnotatedCalls,
    getIntroducedUnreachableCode,
} from '@dd/tests/_jest/helpers/transformInvariants';

describe('Transform invariants', () => {
    const unreachableCases = [
        {
            description: 'accept unchanged code',
            input: 'function f(x) { if (!x) return; work(); }',
            output: 'function f(x) { if (!x) return; work(); }',
            expected: [],
        },
        {
            description: 'report code after a return moved out of its if',
            input: 'function f(x) { if (!x) return; work(); }',
            output: 'function f(x) { if (!x) report(); return; work(); }',
            expected: ['work(); }'],
        },
        {
            description: 'ignore the trailing return report after an exit',
            input: 'function f(x) { switch (x) { default: return 1; } }',
            output: 'function f(x) { switch (x) { default: return 1; } if ($dd_p0) $dd_return($dd_p0, undefined, this); }',
            expected: [],
        },
        {
            description: 'ignore code that was already unreachable',
            input: 'function f() { return; work(); }',
            output: 'function f() { report(); return; work(); }',
            expected: [],
        },
    ];

    test.each(unreachableCases)('should $description', ({ input, output, expected }) => {
        expect(getIntroducedUnreachableCode(input, output)).toEqual(expected);
    });

    test('should fail on output that does not parse', () => {
        expect(() => getIntroducedUnreachableCode('f();', 'f(;')).toThrow('Cannot analyze code');
    });

    const annotationCases = [
        {
            description: 'count an annotation directly in front of a call',
            code: 'const a = /* @__PURE__ */ make();',
            expected: 1,
        },
        {
            description: 'count the #__PURE__ syntax on a new expression',
            code: 'const a = /*#__PURE__*/ new Make();',
            expected: 1,
        },
        {
            description: 'ignore an annotation in front of a parenthesized expression',
            code: 'const a = /* @__PURE__ */ (b = make(), b);',
            expected: 0,
        },
        {
            description: 'ignore other comments',
            code: 'const a = /* note */ make();',
            expected: 0,
        },
    ];

    test.each(annotationCases)('should $description', ({ code, expected }) => {
        expect(countAnnotatedCalls(code)).toBe(expected);
    });

    test('should annotate every call and new expression', () => {
        const annotated = annotateCalls('const a = make(new Make(), other()); a.run();');

        expect(annotated).toBe(
            'const a = /* @__PURE__ */ make(/* @__PURE__ */ new Make(), /* @__PURE__ */ other()); /* @__PURE__ */ a.run();',
        );
        expect(countAnnotatedCalls(annotated)).toBe(4);
    });
});
