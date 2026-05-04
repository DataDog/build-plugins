// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { transformCode, validateSyntax } from './index';

const BASE_OPTIONS = {
    filePath: '/src/utils.ts',
    buildRoot: '/',
    honorSkipComments: false,
    functionTypes: undefined,
    namedOnly: false,
};

describe('transformCode', () => {
    describe('pre-filter', () => {
        it('should skip files with no function syntax', () => {
            const code = 'export const FOO = 42; export type Bar = string;';
            const result = transformCode({
                ...BASE_OPTIONS,
                code,
            });

            expect(result.instrumentedCount).toBe(0);
            expect(result.totalFunctions).toBe(0);
            expect(result.code).toBe(code);
            expect(result.map).toBeUndefined();
        });

        it('should skip files with unsupported imports', () => {
            const code = 'import x from "foo?worker"; function f() { return 1; }';
            const result = transformCode({
                ...BASE_OPTIONS,
                code,
            });

            expect(result.instrumentedCount).toBe(0);
            expect(result.skippedFileCount).toBe(1);
            expect(result.code).toBe(code);
            expect(result.map).toBeUndefined();
        });

        it('should pass pre-filter for files containing only object-literal methods', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'const obj = { method() { return 1; } };',
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.totalFunctions).toBe(1);
            expect(result.code).toContain('$dd_probes');
        });

        it('should pass pre-filter for class with no instrumentable methods', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'class Foo { x = 1; }',
            });

            expect(result.instrumentedCount).toBe(0);
            expect(result.totalFunctions).toBe(0);
            expect(result.skippedFileCount).toBe(0);
            expect(result.code).toBe('class Foo { x = 1; }');
            expect(result.map).toBeUndefined();
        });
    });

    describe('named functions', () => {
        it('should instrument a named function', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function add(a, b) { return a + b; }',
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.totalFunctions).toBe(1);
            expect(result.code).toContain('$dd_probes');
            expect(result.code).toContain('$dd_entry');
            expect(result.code).toContain('$dd_return');
            expect(result.code).toContain('$dd_throw');
            expect(result.map).toBeDefined();
        });

        it('should wrap return values with comma expression', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function add(a, b) { return a + b; }',
            });

            // The return arg should be wrapped: ($dd_rv0 = a + b, probe ? $dd_return(...) : $dd_rv0)
            expect(result.code).toContain('($dd_rv0 = a + b');
        });

        it('should produce valid output for semicolonless final return', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function add(a,b){return a+b}',
            });

            expect(result.instrumentedCount).toBe(1);
            expect(validateSyntax(result.code, '/src/utils.ts')).toBeNull();
            expect(result.code).toContain('($dd_rv0 = a+b');
        });

        it('should produce valid output for semicolonless return with trailing space', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function add(a, b) { return a + b }',
            });

            expect(result.instrumentedCount).toBe(1);
            expect(validateSyntax(result.code, '/src/utils.ts')).toBeNull();
            expect(result.code).toContain('($dd_rv0 = a + b');
        });

        it('should handle return without argument', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function noop() { return; }',
            });

            expect(result.instrumentedCount).toBe(1);
            // return; should have a preceding $dd_return call with undefined
            expect(result.code).toContain('$dd_return');
            expect(result.code).toContain('undefined');
            expect(result.code).toContain('return;');
        });
    });

    describe('arrow functions', () => {
        it('should instrument arrow expression body', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'const double = (x) => x * 2;',
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.code).toContain('$dd_probes');
            expect(result.code).toContain('const $dd_rv0 = ');
            expect(result.code).toContain('return $dd_rv0;');
        });

        it('should instrument arrow block body', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'const fn = (x) => { return x + 1; };',
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.code).toContain('$dd_probes');
            expect(result.code).toContain('($dd_rv0 = x + 1');
        });
    });

    describe('nested functions', () => {
        it('should instrument nested functions independently', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function outer(a) { function inner(b) { return b; } return inner(a); }',
            });

            expect(result.instrumentedCount).toBe(2);
            expect(result.totalFunctions).toBe(2);
        });

        it('should handle nested arrow expression bodies without conflicts', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'const f = (x) => (y) => x + y;',
            });

            expect(result.instrumentedCount).toBe(2);
            // Both functions should be instrumented
            const probeMatches = result.code.match(/\$dd_probes/g);
            expect(probeMatches?.length).toBe(2);
        });
    });

    describe('skipping', () => {
        it('should skip generators', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function* gen() { yield 1; }',
            });

            expect(result.instrumentedCount).toBe(0);
            expect(result.skippedUnsupportedCount).toBe(1);
        });

        it('should skip constructors', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'class Foo { constructor() { this.x = 1; } method() { return this.x; } }',
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.skippedUnsupportedCount).toBe(1);
        });

        it('should return original code when nothing instrumented', () => {
            const code = 'function* gen() { yield 1; }';
            const result = transformCode({
                ...BASE_OPTIONS,
                code,
            });

            expect(result.code).toBe(code);
            expect(result.map).toBeUndefined();
        });
    });

    describe('try-catch wrapping', () => {
        it('should wrap function body in try-catch', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function f() { return 1; }',
            });

            expect(result.code).toContain('try {');
            expect(result.code).toContain('catch(e)');
            expect(result.code).toContain('throw e;');
        });
    });

    describe('directive preservation', () => {
        it('should insert preamble after "use strict" directive', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function f() { "use strict"; return 1; }',
            });

            expect(result.instrumentedCount).toBe(1);
            expect(validateSyntax(result.code, '/src/utils.ts')).toBeNull();
            expect(result.code).toMatch(/"use strict";\s*\nconst \$dd_p0/);
        });

        it('should preserve multiple directives', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: `function f() { "use strict"; "use asm"; return 1; }`,
            });

            expect(result.instrumentedCount).toBe(1);
            expect(validateSyntax(result.code, '/src/utils.ts')).toBeNull();
            expect(result.code).toMatch(/"use asm";\s*\nconst \$dd_p0/);
        });

        it('should not affect functions without directives', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function f() { return 1; }',
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.code).toMatch(/\{\s*const \$dd_p0/);
        });
    });

    describe('hoisted variable capture', () => {
        it('should generate entry and exit helper functions', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function f(a, b) { const c = 1; return a + b + c; }',
            });

            // Entry helper captures params only
            expect(result.code).toMatch(/\$dd_e\d+ = \(\) => \(\{a, b\}\)/);
            // Exit helper captures params + locals
            expect(result.code).toMatch(/\$dd_l\d+ = \(\) => \(\{a, b, c\}\)/);
        });

        it('should emit a single shared helper when entry and exit vars are identical', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function f(a, b) { return a + b; }',
            });

            // Only the entry helper should be emitted
            expect(result.code).toMatch(/\$dd_e\d+ = \(\) => \(\{a, b\}\)/);
            // No exit helper should be present
            expect(result.code).not.toMatch(/\$dd_l\d+/);
        });
    });

    describe('control flow', () => {
        it('should wrap returns in if/else branches', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function f(x) { if (x > 0) { return 1; } else { return -1; } }',
            });

            expect(result.instrumentedCount).toBe(1);
            const returnMatches = result.code.match(/\$dd_rv\d+ =/g);
            expect(returnMatches?.length).toBe(2);
        });

        it('should wrap returns in switch cases', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function f(x) { switch(x) { case 1: return "one"; case 2: return "two"; default: return "other"; } }',
            });

            expect(result.instrumentedCount).toBe(1);
            const returnMatches = result.code.match(/\$dd_rv\d+ =/g);
            expect(returnMatches?.length).toBe(3);
        });

        it('should wrap returns in try/catch/finally', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function f() { try { return 1; } catch(e) { return 2; } finally { /* cleanup */ } }',
            });

            expect(result.instrumentedCount).toBe(1);
            const returnMatches = result.code.match(/\$dd_rv\d+ =/g);
            expect(returnMatches?.length).toBe(2);
        });

        it('should wrap returns inside with statements', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function f(obj) { with (obj) { return x; } }',
            });

            expect(result.instrumentedCount).toBe(1);
            const returnMatches = result.code.match(/\$dd_rv\d+ =/g);
            expect(returnMatches?.length).toBe(1);
        });
    });

    describe('source maps', () => {
        it('should generate a source map when code is instrumented', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function add(a, b) { return a + b; }',
            });

            expect(result.map).toBeDefined();
            expect(result.map?.sources).toContain('/src/utils.ts');
        });
    });

    describe('functionTypes filtering', () => {
        const mixedCode = [
            'function decl() { return 1; }',
            'const expr = function() { return 2; };',
            'const arrow = () => 3;',
            'const obj = { method() { return 4; } };',
            'class Foo { classMethod() { return 5; } }',
        ].join('\n');

        it('should instrument all function types when functionTypes is undefined', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: mixedCode,
            });

            expect(result.instrumentedCount).toBe(5);
            expect(result.totalFunctions).toBe(5);
        });

        it('should instrument only function declarations', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: mixedCode,
                functionTypes: ['functionDeclaration'],
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.code).toContain("$dd_probes('src/utils.ts;decl')");
        });

        it('should instrument only arrow functions', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: mixedCode,
                functionTypes: ['arrowFunction'],
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.code).toContain("$dd_probes('src/utils.ts;arrow')");
        });

        it('should instrument only function expressions', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: mixedCode,
                functionTypes: ['functionExpression'],
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.code).toContain("$dd_probes('src/utils.ts;expr')");
        });

        it('should instrument only object methods', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: mixedCode,
                functionTypes: ['objectMethod'],
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.code).toContain("$dd_probes('src/utils.ts;method')");
        });

        it('should instrument only class methods', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: mixedCode,
                functionTypes: ['classMethod'],
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.code).toContain("$dd_probes('src/utils.ts;classMethod')");
        });

        it('should instrument only class private methods', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'class Foo { #secret() { return 42; } pub() { return 1; } }',
                functionTypes: ['classPrivateMethod'],
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.code).toContain("$dd_probes('src/utils.ts;#secret')");
        });

        it('should instrument multiple selected types', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: mixedCode,
                functionTypes: ['arrowFunction', 'classMethod', 'functionDeclaration'],
            });

            expect(result.instrumentedCount).toBe(3);
            expect(result.code).toContain("$dd_probes('src/utils.ts;decl')");
            expect(result.code).toContain("$dd_probes('src/utils.ts;arrow')");
            expect(result.code).toContain("$dd_probes('src/utils.ts;classMethod')");
        });

        it('should return original code when no functions match the filter', () => {
            const code = 'const arrow = () => 1;';
            const result = transformCode({
                ...BASE_OPTIONS,
                code,
                functionTypes: ['classMethod'],
            });

            expect(result.instrumentedCount).toBe(0);
            expect(result.code).toBe(code);
            expect(result.map).toBeUndefined();
        });
    });

    describe('namedOnly filtering', () => {
        it('should skip anonymous functions when namedOnly is true', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: '[1, 2].map((x) => x * 2);',
                namedOnly: true,
            });

            expect(result.instrumentedCount).toBe(0);
        });

        it('should instrument named functions when namedOnly is true', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'const double = (x) => x * 2;',
                namedOnly: true,
            });

            expect(result.instrumentedCount).toBe(1);
        });

        it('should instrument all functions when namedOnly is false', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: '[1, 2].map((x) => x * 2); const fn = () => 1;',
                namedOnly: false,
            });

            expect(result.instrumentedCount).toBe(2);
        });

        it('should combine namedOnly with functionTypes', () => {
            const code = [
                'const named = () => 1;',
                '[].map(() => 2);',
                'function decl() { return 3; }',
            ].join('\n');

            const result = transformCode({
                ...BASE_OPTIONS,
                code,
                functionTypes: ['arrowFunction'],
                namedOnly: true,
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.code).toContain("$dd_probes('src/utils.ts;named')");
        });
    });

    describe('skip comments', () => {
        const SKIP_OPTIONS = { ...BASE_OPTIONS, honorSkipComments: true };

        it('should skip a const arrow function with a comment above', () => {
            const result = transformCode({
                ...SKIP_OPTIONS,
                code: '// @dd-no-instrumentation\nconst fn = () => 1;',
            });

            expect(result.instrumentedCount).toBe(0);
            expect(result.skippedByCommentCount).toBe(1);
            expect(result.code).not.toContain('$dd_probes');
        });

        it('should skip an exported const arrow function with a comment above', () => {
            const result = transformCode({
                ...SKIP_OPTIONS,
                code: '// @dd-no-instrumentation\nexport const fn = () => 1;',
            });

            expect(result.instrumentedCount).toBe(0);
            expect(result.skippedByCommentCount).toBe(1);
        });

        it('should skip a named function declaration with a comment above', () => {
            const result = transformCode({
                ...SKIP_OPTIONS,
                code: '// @dd-no-instrumentation\nfunction greet() { return "hi"; }',
            });

            expect(result.instrumentedCount).toBe(0);
            expect(result.skippedByCommentCount).toBe(1);
        });

        it('should only skip the annotated declaration, not its successor', () => {
            const result = transformCode({
                ...SKIP_OPTIONS,
                code: [
                    '// @dd-no-instrumentation',
                    'const fn1 = () => 1;',
                    'const fn2 = () => 2;',
                ].join('\n'),
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.skippedByCommentCount).toBe(1);
            expect(result.code).toContain("$dd_probes('src/utils.ts;fn2')");
            expect(result.code).not.toContain("$dd_probes('src/utils.ts;fn1')");
        });

        it('should not skip an inner function when the outer function is annotated', () => {
            const result = transformCode({
                ...SKIP_OPTIONS,
                code: [
                    '// @dd-no-instrumentation',
                    'function outer() {',
                    '  const inner = () => 1;',
                    '  return inner();',
                    '}',
                ].join('\n'),
            });

            // outer is skipped, but inner should still be instrumented
            expect(result.skippedByCommentCount).toBe(1);
            expect(result.instrumentedCount).toBe(1);
            expect(result.code).toContain("$dd_probes('src/utils.ts;inner')");
        });

        it('should skip all declarators in a multi-declarator const with a comment above', () => {
            const result = transformCode({
                ...SKIP_OPTIONS,
                code: '// @dd-no-instrumentation\nconst a = () => 1, b = () => 2;',
            });

            // Both arrows share the same VariableDeclaration, so both are skipped
            expect(result.instrumentedCount).toBe(0);
            expect(result.skippedByCommentCount).toBe(2);
        });

        it('should skip an exported function declaration with a comment above', () => {
            const result = transformCode({
                ...SKIP_OPTIONS,
                code: '// @dd-no-instrumentation\nexport function greet() { return "hi"; }',
            });

            expect(result.instrumentedCount).toBe(0);
            expect(result.skippedByCommentCount).toBe(1);
        });

        it('should not skip a function when the comment is on an unrelated prior statement', () => {
            const result = transformCode({
                ...SKIP_OPTIONS,
                code: ['// @dd-no-instrumentation', 'const x = 42;', 'const fn = () => 1;'].join(
                    '\n',
                ),
            });

            // The comment attaches to the `const x = 42` declaration, not to fn
            expect(result.instrumentedCount).toBe(1);
            expect(result.code).toContain("$dd_probes('src/utils.ts;fn')");
        });
    });

    describe('quoted method names', () => {
        it('should instrument an object with a string-keyed method', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: "const obj = { 'my-method'() { return 1; } };",
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.code).toContain("$dd_probes('src/utils.ts;my-method')");
            expect(validateSyntax(result.code, '/src/utils.ts')).toBeNull();
        });

        it('should instrument an object with a numeric-keyed method', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'const obj = { 42() { return 1; } };',
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.code).toContain("$dd_probes('src/utils.ts;42')");
            expect(validateSyntax(result.code, '/src/utils.ts')).toBeNull();
        });

        it('should produce invalid syntax when a method name contains a single quote (known limitation)', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: `const obj = { "it's"() { return 1; } };`,
            });

            // The unescaped single quote in the function ID breaks the
            // generated $dd_probes('...') call — see TODO in injectInstrumentation.
            expect(result.instrumentedCount).toBe(1);
            expect(validateSyntax(result.code, '/src/utils.ts')).not.toBeNull();
        });
    });

    describe('deterministic output', () => {
        it('should produce identical output across repeated transforms in the same process', () => {
            const options = {
                ...BASE_OPTIONS,
                code: [
                    'function add(a, b) { return a + b; }',
                    'const mul = (x, y) => x * y;',
                    'class Calc { sum(a, b) { return a + b; } }',
                ].join('\n'),
            };

            const result1 = transformCode(options);
            const result2 = transformCode(options);
            const result3 = transformCode(options);

            expect(result1.code).toBe(result2.code);
            expect(result2.code).toBe(result3.code);
            expect(result1.instrumentedCount).toBe(result2.instrumentedCount);
            expect(result2.instrumentedCount).toBe(result3.instrumentedCount);
        });
    });

    describe('full output (smoke tests)', () => {
        function normalizeCode(...lines: string[]): string {
            return lines.map((s) => s.trimStart()).join('\n');
        }

        it('should produce the expected output for a function with a single return', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function add(a, b) { return a + b; }',
            });

            expect(normalizeCode(result.code)).toBe(
                normalizeCode(
                    "function add(a, b) {const $dd_p0 = $dd_probes('src/utils.ts;add');",
                    '  const $dd_e0 = () => ({a, b});',
                    '  try {',
                    '    let $dd_rv0;',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, $dd_e0()); return ($dd_rv0 = a + b, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, $dd_e0(), $dd_e0()) : $dd_rv0); ',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, $dd_e0()); throw e; }',
                    '}',
                ),
            );
        });

        it('should produce the expected output for a function with local variables', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function add(a, b) { const sum = a + b; return sum; }',
            });

            expect(normalizeCode(result.code)).toBe(
                normalizeCode(
                    "function add(a, b) {const $dd_p0 = $dd_probes('src/utils.ts;add');",
                    '  const $dd_e0 = () => ({a, b});',
                    '  try {',
                    '    const $dd_l0 = () => ({a, b, sum});',
                    '    let $dd_rv0;',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, $dd_e0()); const sum = a + b; return ($dd_rv0 = sum, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, $dd_e0(), $dd_l0()) : $dd_rv0); ',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, $dd_e0()); throw e; }',
                    '}',
                ),
            );
        });

        it('should produce the expected output for an arrow function with expression body', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'const double = (x) => x * 2;',
            });

            expect(normalizeCode(result.code)).toBe(
                normalizeCode(
                    'const double = (x) => {',
                    "  const $dd_p0 = $dd_probes('src/utils.ts;double');",
                    '  const $dd_e0 = () => ({x});',
                    '  try {',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, $dd_e0());',
                    '    const $dd_rv0 = x * 2;',
                    '    if ($dd_p0) $dd_return($dd_p0, $dd_rv0, this, $dd_e0(), $dd_e0());',
                    '    return $dd_rv0;',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, $dd_e0()); throw e; }',
                    '};',
                ),
            );
        });

        it('should produce the expected output for an arrow function with parenthesized expression body', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'const getObj = (x) => ({key: x});',
            });

            expect(normalizeCode(result.code)).toBe(
                normalizeCode(
                    'const getObj = (x) => {',
                    "  const $dd_p0 = $dd_probes('src/utils.ts;getObj');",
                    '  const $dd_e0 = () => ({x});',
                    '  try {',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, $dd_e0());',
                    '    const $dd_rv0 = {key: x};',
                    '    if ($dd_p0) $dd_return($dd_p0, $dd_rv0, this, $dd_e0(), $dd_e0());',
                    '    return $dd_rv0;',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, $dd_e0()); throw e; }',
                    '};',
                ),
            );
        });

        it('should produce the expected output for a function with no return statement', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function log(msg) { console.log(msg); }',
            });

            expect(normalizeCode(result.code)).toBe(
                normalizeCode(
                    "function log(msg) {const $dd_p0 = $dd_probes('src/utils.ts;log');",
                    '  const $dd_e0 = () => ({msg});',
                    '  try {',
                    '    let $dd_rv0;',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, $dd_e0()); console.log(msg); ',
                    '    if ($dd_p0) $dd_return($dd_p0, undefined, this, $dd_e0(), $dd_e0());',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, $dd_e0()); throw e; }',
                    '}',
                ),
            );
        });

        it('should produce the expected output for a function with multiple returns', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function abs(x) { if (x < 0) { return -x; } return x; }',
            });

            expect(normalizeCode(result.code)).toBe(
                normalizeCode(
                    "function abs(x) {const $dd_p0 = $dd_probes('src/utils.ts;abs');",
                    '  const $dd_e0 = () => ({x});',
                    '  try {',
                    '    let $dd_rv0;',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, $dd_e0()); if (x < 0) { return ($dd_rv0 = -x, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, $dd_e0(), $dd_e0()) : $dd_rv0); } return ($dd_rv0 = x, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, $dd_e0(), $dd_e0()) : $dd_rv0); ',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, $dd_e0()); throw e; }',
                    '}',
                ),
            );
        });

        it('should produce the expected output for a function with a bare return', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function earlyExit(x) { if (!x) { return; } console.log(x); }',
            });

            expect(normalizeCode(result.code)).toBe(
                normalizeCode(
                    "function earlyExit(x) {const $dd_p0 = $dd_probes('src/utils.ts;earlyExit');",
                    '  const $dd_e0 = () => ({x});',
                    '  try {',
                    '    let $dd_rv0;',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, $dd_e0()); if (!x) { if ($dd_p0) $dd_return($dd_p0, undefined, this, $dd_e0(), $dd_e0()); return; } console.log(x); ',
                    '    if ($dd_p0) $dd_return($dd_p0, undefined, this, $dd_e0(), $dd_e0());',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, $dd_e0()); throw e; }',
                    '}',
                ),
            );
        });

        it('should omit the trailing return for a function with exhaustive if/else returns', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: normalizeCode(
                    'function sign(x) {',
                    '  if (x > 0) {',
                    '    return 1;',
                    '  } else {',
                    '    return -1;',
                    '  }',
                    '}',
                ),
            });

            expect(normalizeCode(result.code)).toBe(
                normalizeCode(
                    "function sign(x) {const $dd_p0 = $dd_probes('src/utils.ts;sign');",
                    '  const $dd_e0 = () => ({x});',
                    '  try {',
                    '    let $dd_rv0;',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, $dd_e0());',
                    '    if (x > 0) {',
                    '      return ($dd_rv0 = 1, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, $dd_e0(), $dd_e0()) : $dd_rv0);',
                    '    } else {',
                    '      return ($dd_rv0 = -1, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, $dd_e0(), $dd_e0()) : $dd_rv0);',
                    '    }',
                    '',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, $dd_e0()); throw e; }',
                    '}',
                ),
            );
        });
    });
});
