// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parse } from '@babel/parser';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import { runInNewContext } from 'vm';

import { transformCode } from './index';

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

        it('should preserve sequence expression semantics in return statements', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function f() { let a = 0; return (a = 2), a + 10; }',
            });

            expect(result.instrumentedCount).toBe(1);
            expect(validateSyntax(result.code, '/src/utils.ts')).toBeNull();
            expect(result.code).toContain('return ($dd_rv0 = ((a = 2), a + 10),');
            expect(runTransformedFunction(result.code)).toBe(12);
        });

        it('should preserve all sequence expression side effects in return statements', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function f() { const log = []; return log.push(1), log.push(2), log.length; }',
            });

            expect(result.instrumentedCount).toBe(1);
            expect(validateSyntax(result.code, '/src/utils.ts')).toBeNull();
            expect(result.code).toContain(
                'return ($dd_rv0 = (log.push(1), log.push(2), log.length),',
            );
            expect(runTransformedFunction(result.code)).toBe(2);
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

        it('should preserve comma operator semantics in arrow expression body', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'const fn = () => (sideEffect(), value);',
            });

            expect(result.instrumentedCount).toBe(1);
            expect(validateSyntax(result.code, '/src/utils.ts')).toBeNull();
            expect(result.code).toContain('const $dd_rv0 = (sideEffect(), value);');
        });

        it('should instrument arrow expression body wrapped in nested parentheses', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'const fn = () => ((1));',
            });

            expect(result.instrumentedCount).toBe(1);
            const syntaxError = validateSyntax(result.code, '/src/utils.ts');
            expect(syntaxError).toBeNull();
        });

        it('should instrument arrow object expression body wrapped in nested parentheses', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'const fn = () => (({a: 1}));',
            });

            expect(result.instrumentedCount).toBe(1);
            const syntaxError = validateSyntax(result.code, '/src/utils.ts');
            expect(syntaxError).toBeNull();
        });

        it('should not access derived constructor this before super in arrow expression bodies', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: [
                    'class A {}',
                    'class B extends A {',
                    '  constructor(items) {',
                    '    super(items.map((x) => x * 2));',
                    '  }',
                    '}',
                ].join('\n'),
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.skippedUnsupportedCount).toBe(1);
            expect(validateSyntax(result.code, '/src/utils.ts')).toBeNull();
            expect(result.code).toContain('constructor(items) {let $dd_t;');
            expect(result.code).toContain('super(items.map((x) => {');
            expect(result.code).toContain('$dd_entry($dd_p0, $dd_t, {x})');
            expect(result.code).toContain('$dd_return($dd_p0, $dd_rv0, $dd_t, {x})');
            expect(result.code).toContain('$dd_throw($dd_p0, e, $dd_t, {x})');
            expect(result.code).not.toContain('$dd_entry($dd_p0, this');
            expect(result.code).not.toContain('$dd_return($dd_p0, $dd_rv0, this');
            expect(result.code).not.toContain('$dd_throw($dd_p0, e, this');
        });

        it('should handle arrow expression bodies that are super calls', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: [
                    'class A {}',
                    'class B extends A {',
                    '  constructor(args) {',
                    '    const init = () => super(args);',
                    '    init();',
                    '  }',
                    '}',
                ].join('\n'),
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.skippedUnsupportedCount).toBe(1);
            expect(validateSyntax(result.code, '/src/utils.ts')).toBeNull();
            expect(result.code).toContain('const $dd_rv0 = ($dd_t = super(args));');
            expect(result.code).not.toContain('=> ($dd_t = {');
        });

        it('should keep direct this capture for arrows outside derived constructors', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'const double = (x) => x * 2;',
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.code).toContain('$dd_entry($dd_p0, this, {x})');
            expect(result.code).not.toContain('let $dd_t');
        });

        it('should keep direct this capture for function expressions in derived constructors', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: [
                    'class A {}',
                    'class B extends A {',
                    '  constructor(items) {',
                    '    const double = function(x) { return x * 2; };',
                    '    super(items.map(double));',
                    '  }',
                    '}',
                ].join('\n'),
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.skippedUnsupportedCount).toBe(1);
            expect(result.code).toContain('$dd_entry($dd_p0, this, {x})');
            expect(result.code).not.toContain('let $dd_t');
        });
    });

    describe('nested functions', () => {
        const nestedSyntaxCases = [
            {
                description: 'nested function declarations',
                code: 'function outer(a) { function inner(b) { return b; } return inner(a); }',
                namedOnly: false,
                expectedInstrumentedCount: 2,
                expectedTotalFunctions: 2,
            },
            {
                description: 'arrow returning named function expression',
                code: 'const make = (dep) => function named() { return dep; };',
                namedOnly: false,
                expectedInstrumentedCount: 2,
                expectedTotalFunctions: 2,
            },
            {
                description: 'arrow returning named function expression',
                code: 'const make = (dep) => function named() { return dep; };',
                namedOnly: true,
                expectedInstrumentedCount: 2,
                expectedTotalFunctions: 2,
            },
            {
                description: 'exported arrow returning function expression with inner declaration',
                code: 'export const remarkSymbol = (o) => function remarkSymbolPlugin() { const d = o; function add(){ d; } add(); };',
                namedOnly: false,
                expectedInstrumentedCount: 3,
                expectedTotalFunctions: 3,
            },
            {
                description: 'exported arrow returning function expression with inner declaration',
                code: 'export const remarkSymbol = (o) => function remarkSymbolPlugin() { const d = o; function add(){ d; } add(); };',
                namedOnly: true,
                expectedInstrumentedCount: 3,
                expectedTotalFunctions: 3,
            },
            {
                description: 'triple-nested function expression callback',
                code: 'const build = (n) => function useThing() { return cb(function record(){ size(n); }, []); };',
                namedOnly: false,
                expectedInstrumentedCount: 3,
                expectedTotalFunctions: 3,
            },
            {
                description: 'triple-nested function expression callback',
                code: 'const build = (n) => function useThing() { return cb(function record(){ size(n); }, []); };',
                namedOnly: true,
                expectedInstrumentedCount: 3,
                expectedTotalFunctions: 3,
            },
            {
                description: 'nested arrow expression bodies',
                code: 'const f = (x) => (y) => x + y;',
                namedOnly: false,
                expectedInstrumentedCount: 2,
                expectedTotalFunctions: 2,
            },
            {
                description: 'curried arrow expression body with anonymous inner arrow skipped',
                code: 'const f = (a) => (b) => a + b;',
                namedOnly: true,
                expectedInstrumentedCount: 1,
                expectedTotalFunctions: 2,
            },
            {
                description: 'block-body arrow returning an expression-body arrow',
                code: 'export const make = (cond) => { return () => cond ? a() : b(); };',
                namedOnly: false,
                expectedInstrumentedCount: 2,
                expectedTotalFunctions: 2,
            },
            {
                description: 'function declaration returning an expression-body arrow',
                code: 'export function build(x) { const y = x + 1; return () => y > 0 ? pos(y) : neg(y); }',
                namedOnly: false,
                expectedInstrumentedCount: 2,
                expectedTotalFunctions: 2,
            },
            {
                description: 'block-body arrow returning an expression-body arrow with JSX mapping',
                code: 'type Row = { id: string }; export const C = (rows: Row[]) => { const n = rows.length; return () => rows.map((r) => <li key={r.id}>{n}</li>); };',
                namedOnly: false,
                expectedInstrumentedCount: 3,
                expectedTotalFunctions: 3,
            },
            {
                description: 'block-body arrow returning a block-body arrow',
                code: 'export const make = (cond) => { return () => { return cond ? a() : b(); }; };',
                namedOnly: false,
                expectedInstrumentedCount: 2,
                expectedTotalFunctions: 2,
            },
            {
                description: 'parenthesized inner arrow abutting the closing paren',
                code: 'const f = (a) => ((b) => a + b);',
                namedOnly: false,
                expectedInstrumentedCount: 2,
                expectedTotalFunctions: 2,
            },
            {
                description: 'parenthesized inner arrow abutting the closing paren (namedOnly)',
                code: 'const f = (a) => ((b) => a + b);',
                namedOnly: true,
                expectedInstrumentedCount: 1,
                expectedTotalFunctions: 2,
            },
            {
                description: 'double-parenthesized inner arrow',
                code: 'const f = (a) => (((b) => a + b));',
                namedOnly: false,
                expectedInstrumentedCount: 2,
                expectedTotalFunctions: 2,
            },
            {
                description: 'nested parenthesized curried arrows',
                code: 'const f = (a) => ((b) => ((c) => a + b + c));',
                namedOnly: false,
                expectedInstrumentedCount: 3,
                expectedTotalFunctions: 3,
            },
            {
                description: 'parenthesized inner arrow returning JSX',
                code: 'const f = (a) => ((b) => <li>{a}{b}</li>);',
                namedOnly: false,
                expectedInstrumentedCount: 2,
                expectedTotalFunctions: 2,
            },
            {
                description: 'parenthesized inner arrow returning a parenthesized object',
                code: 'const f = (a) => ((b) => ({ sum: a + b }));',
                namedOnly: false,
                expectedInstrumentedCount: 2,
                expectedTotalFunctions: 2,
            },
        ];

        test.each(nestedSyntaxCases)(
            'should produce valid output for $description with namedOnly $namedOnly',
            ({ code, namedOnly, expectedInstrumentedCount, expectedTotalFunctions }) => {
                const result = transformCode({
                    ...BASE_OPTIONS,
                    code,
                    namedOnly,
                });

                const syntaxError = validateSyntax(result.code, '/src/utils.ts');
                const probeMatches = result.code.match(/\$dd_probes/g);
                expect(syntaxError).toBeNull();
                expect(result.instrumentedCount).toBe(expectedInstrumentedCount);
                expect(result.totalFunctions).toBe(expectedTotalFunctions);
                expect(probeMatches?.length).toBe(expectedInstrumentedCount);
                expect(result.code).toContain('$dd_return');
                expect(result.code).toContain('catch(e)');
            },
        );
    });

    describe('parenthesized arrow bodies with comments', () => {
        // The wrapper-paren scanner must skip comments; a stray paren inside a
        // comment must not be mistaken for a wrapping paren, otherwise removal
        // misaligns and produces invalid JavaScript.
        const commentCases = [
            'const f = () => (/* ( */ x);',
            'const f = () => (x /* ) */);',
            'const f = () => (/* ( */ (x));',
            'const f = () => ((x) /* ) */);',
            'const f = () => (\n  // returns (something)\n  value\n);',
            'const f = () => (/* le(ading */ (y) /* trai)ling */);',
            // A regex/division `/` inside the body must not be treated as a
            // comment start by the wrapper-paren scanner.
            'const f = () => (/[)(]/);',
            'const f = () => (/[)(]/g.test(x) ? a : b);',
        ];

        test.each(commentCases.map((code) => ({ code })))(
            'should produce valid output for $code',
            ({ code }) => {
                const result = transformCode({ ...BASE_OPTIONS, code });

                expect(result.instrumentedCount).toBe(1);
                expect(validateSyntax(result.code, '/src/utils.ts')).toBeNull();
                expect(result.code).toContain('$dd_return');
                expect(result.code).toContain('catch(e)');
            },
        );
    });

    describe('async functions', () => {
        const asyncCases = [
            {
                description: 'async function declaration with await',
                code: 'async function f(a) { return await g(a); }',
                expectedInstrumentedCount: 1,
                expectedTotalFunctions: 1,
            },
            {
                description: 'async arrow expression body',
                code: 'const f = async (a) => await g(a);',
                expectedInstrumentedCount: 1,
                expectedTotalFunctions: 1,
            },
            {
                description: 'async arrow with unparenthesized param',
                code: 'const f = async a => a;',
                expectedInstrumentedCount: 1,
                expectedTotalFunctions: 1,
            },
            {
                description: 'async arrow block body',
                code: 'const f = async (a) => { return await g(a); };',
                expectedInstrumentedCount: 1,
                expectedTotalFunctions: 1,
            },
            {
                description: 'async arrow with parenthesized object body',
                code: 'const f = async (a) => ({ v: await g(a) });',
                expectedInstrumentedCount: 1,
                expectedTotalFunctions: 1,
            },
            {
                description: 'async object method',
                code: 'const o = { async m(a) { return await g(a); } };',
                expectedInstrumentedCount: 1,
                expectedTotalFunctions: 1,
            },
            {
                description: 'async class method',
                code: 'class C { async m(a) { return await g(a); } }',
                expectedInstrumentedCount: 1,
                expectedTotalFunctions: 1,
            },
            {
                description: 'curried async arrow with parenthesized inner arrow',
                code: 'const f = async (a) => ((b) => a + b);',
                expectedInstrumentedCount: 2,
                expectedTotalFunctions: 2,
            },
        ];

        test.each(asyncCases)(
            'should produce valid output for $description',
            ({ code, expectedInstrumentedCount, expectedTotalFunctions }) => {
                const result = transformCode({ ...BASE_OPTIONS, code });

                expect(validateSyntax(result.code, '/src/utils.ts')).toBeNull();
                expect(result.instrumentedCount).toBe(expectedInstrumentedCount);
                expect(result.totalFunctions).toBe(expectedTotalFunctions);
                expect(result.code).toContain('$dd_probes');
                expect(result.code).toContain('catch(e)');
            },
        );
    });

    describe('accessors and static members', () => {
        const accessorCases = [
            {
                description: 'class getter',
                code: 'class C { get x() { return this._x; } }',
                expectedInstrumentedCount: 1,
                expectedTotalFunctions: 1,
            },
            {
                description: 'class setter',
                code: 'class C { set x(v) { this._x = v; } }',
                expectedInstrumentedCount: 1,
                expectedTotalFunctions: 1,
            },
            {
                description: 'object getter and setter',
                code: 'const o = { get x() { return 1; }, set x(v) { this._x = v; } };',
                expectedInstrumentedCount: 2,
                expectedTotalFunctions: 2,
            },
            {
                description: 'static method',
                code: 'class C { static m(a) { return a; } }',
                expectedInstrumentedCount: 1,
                expectedTotalFunctions: 1,
            },
            {
                description: 'static block alongside a method',
                code: 'class C { static { init(); } m() { return 1; } }',
                expectedInstrumentedCount: 1,
                expectedTotalFunctions: 1,
            },
        ];

        test.each(accessorCases)(
            'should produce valid output for $description',
            ({ code, expectedInstrumentedCount, expectedTotalFunctions }) => {
                const result = transformCode({ ...BASE_OPTIONS, code });

                expect(validateSyntax(result.code, '/src/utils.ts')).toBeNull();
                expect(result.instrumentedCount).toBe(expectedInstrumentedCount);
                expect(result.totalFunctions).toBe(expectedTotalFunctions);
                expect(result.code).toContain('catch(e)');
            },
        );
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

    describe('local variable capture', () => {
        it('should inline args and local captures', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function f(a, b) { const c = 1; return a + b + c; }',
            });

            expect(result.code).toContain('$dd_entry($dd_p0, this, {a, b})');
            expect(result.code).toContain('$dd_return($dd_p0, $dd_rv0, this, {a, b}, {c})');
        });

        it('should omit local captures when there are no locals', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function f(a, b) { return a + b; }',
            });

            expect(result.code).toContain('$dd_entry($dd_p0, this, {a, b})');
            expect(result.code).toContain('$dd_return($dd_p0, $dd_rv0, this, {a, b})');
        });

        it('should omit both helpers when there are no params and no locals', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function f() { return 1; }',
            });

            expect(result.code).not.toMatch(/\$dd_e\d+/);
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

        it('should map the injected entry call back to the original function line', () => {
            // Even though the preamble lands on its own generated lines (not on
            // the function declaration line) the source map must resolve every
            // injected line back to the function it wraps. Magic-string
            // populates each injected line with a segment via `s.update()`;
            // before that, purely-injected lines had no segments at all and
            // resolved to `null`.
            const code = [
                "import { isDefined } from '@lib/type-guards';",
                '',
                'function getDebuggerServicesStatus(isLoadingCritical) {',
                "    return isLoadingCritical ? 'loading' : 'completed';",
                '}',
            ].join('\n');
            const result = transformCode({ ...BASE_OPTIONS, code });

            expect(result.map).toBeDefined();
            const lines = result.code.split('\n');
            const entryLineIndex = lines.findIndex((line) => line.includes('$dd_entry($dd_p0'));
            expect(entryLineIndex).toBeGreaterThan(-1);

            const traceMap = new TraceMap(JSON.parse(result.map!.toString()));
            const entryColumn = lines[entryLineIndex].indexOf('$dd_entry');
            const original = originalPositionFor(traceMap, {
                line: entryLineIndex + 1,
                column: entryColumn,
            });

            // Original function declaration is on line 3 (1-indexed) of the
            // source. Mapping any column on the entry-call line back through
            // the source map must land on that line, regardless of the column.
            expect(original.line).toBe(3);
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

        it('should escape a method name containing a single quote', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: `const obj = { "it's"() { return 1; } };`,
            });

            expect(result.instrumentedCount).toBe(1);
            expect(result.code).toContain("$dd_probes('src/utils.ts;it\\'s')");
            expect(validateSyntax(result.code, '/src/utils.ts')).toBeNull();
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

        it('should produce the expected output for a function with no arguments', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function getTime() { return Date.now(); }',
            });

            expect(normalizeCode(result.code)).toBe(
                normalizeCode(
                    "function getTime() {const $dd_p0 = $dd_probes('src/utils.ts;getTime');",
                    '  try {',
                    '    let $dd_rv0;',
                    '    if ($dd_p0) $dd_entry($dd_p0, this); return ($dd_rv0 = Date.now(), $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this) : $dd_rv0); ',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this); throw e; }',
                    '}',
                ),
            );
        });

        it('should produce the expected output for a function with no arguments but with locals', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function getTime() { const now = Date.now(); return now; }',
            });

            expect(normalizeCode(result.code)).toBe(
                normalizeCode(
                    "function getTime() {const $dd_p0 = $dd_probes('src/utils.ts;getTime');",
                    '  try {',
                    '    let $dd_rv0;',
                    '    if ($dd_p0) $dd_entry($dd_p0, this); const now = Date.now(); return ($dd_rv0 = now, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, undefined, {now}) : $dd_rv0); ',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this); throw e; }',
                    '}',
                ),
            );
        });

        it('should produce the expected output for a function with a single return', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function add(a, b) { return a + b; }',
            });

            expect(normalizeCode(result.code)).toBe(
                normalizeCode(
                    "function add(a, b) {const $dd_p0 = $dd_probes('src/utils.ts;add');",
                    '  try {',
                    '    let $dd_rv0;',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, {a, b}); return ($dd_rv0 = a + b, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {a, b}) : $dd_rv0); ',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {a, b}); throw e; }',
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
                    '  try {',
                    '    let $dd_rv0;',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, {a, b}); const sum = a + b; return ($dd_rv0 = sum, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {a, b}, {sum}) : $dd_rv0); ',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {a, b}); throw e; }',
                    '}',
                ),
            );
        });

        it('should produce the expected output for returns before local declarations', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function f(flag) { if (flag) { return 1; } const later = 2; return later; }',
            });

            expect(normalizeCode(result.code)).toBe(
                normalizeCode(
                    "function f(flag) {const $dd_p0 = $dd_probes('src/utils.ts;f');",
                    '  try {',
                    '    let $dd_rv0;',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, {flag}); if (flag) { return ($dd_rv0 = 1, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {flag}) : $dd_rv0); } const later = 2; return ($dd_rv0 = later, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {flag}, {later}) : $dd_rv0); ',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {flag}); throw e; }',
                    '}',
                ),
            );
        });

        it('should produce the expected output for returns before shadowing locals', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: 'function f() { let a = 1; if (a) { return; let a = 2; return a; } }',
            });

            expect(normalizeCode(result.code)).toBe(
                normalizeCode(
                    "function f() {const $dd_p0 = $dd_probes('src/utils.ts;f');",
                    '  try {',
                    '    let $dd_rv0;',
                    '    if ($dd_p0) $dd_entry($dd_p0, this); let a = 1; if (a) { if ($dd_p0) $dd_return($dd_p0, undefined, this); return; let a = 2; return ($dd_rv0 = a, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, undefined, {a}) : $dd_rv0); } ',
                    '    if ($dd_p0) $dd_return($dd_p0, undefined, this, undefined, {a});',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this); throw e; }',
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
                    '  try {',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, {x});',
                    '    const $dd_rv0 = x * 2;',
                    '    if ($dd_p0) $dd_return($dd_p0, $dd_rv0, this, {x});',
                    '    return $dd_rv0;',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {x}); throw e; }',
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
                    '  try {',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, {x});',
                    '    const $dd_rv0 = {key: x};',
                    '    if ($dd_p0) $dd_return($dd_p0, $dd_rv0, this, {x});',
                    '    return $dd_rv0;',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {x}); throw e; }',
                    '};',
                ),
            );
        });

        it('should produce the expected output for an arrow in a derived constructor super call', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: normalizeCode(
                    'class A {}',
                    'class B extends A {',
                    '  constructor(items) {',
                    '    super(items.map((x) => x * 2));',
                    '  }',
                    '}',
                ),
            });

            expect(normalizeCode(result.code)).toBe(
                normalizeCode(
                    'class A {}',
                    'class B extends A {',
                    '  constructor(items) {let $dd_t;',
                    '    ($dd_t = super(items.map((x) => {',
                    "      const $dd_p0 = $dd_probes('src/utils.ts;<anonymous>@4:16:0');",
                    '      try {',
                    '        if ($dd_p0) $dd_entry($dd_p0, $dd_t, {x});',
                    '        const $dd_rv0 = x * 2;',
                    '        if ($dd_p0) $dd_return($dd_p0, $dd_rv0, $dd_t, {x});',
                    '        return $dd_rv0;',
                    '      } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, $dd_t, {x}); throw e; }',
                    '    })));',
                    '  }',
                    '}',
                ),
            );
        });

        it('should produce the expected output for an arrow body super call in a derived constructor', () => {
            const result = transformCode({
                ...BASE_OPTIONS,
                code: normalizeCode(
                    'class A {}',
                    'class B extends A {',
                    '  constructor(args) {',
                    '    const init = () => super(args);',
                    '    init();',
                    '  }',
                    '}',
                ),
            });

            expect(normalizeCode(result.code)).toBe(
                normalizeCode(
                    'class A {}',
                    'class B extends A {',
                    '  constructor(args) {let $dd_t;',
                    '    const init = () => {',
                    "      const $dd_p0 = $dd_probes('src/utils.ts;init');",
                    '      try {',
                    '        if ($dd_p0) $dd_entry($dd_p0, $dd_t);',
                    '        const $dd_rv0 = ($dd_t = super(args));',
                    '        if ($dd_p0) $dd_return($dd_p0, $dd_rv0, $dd_t);',
                    '        return $dd_rv0;',
                    '      } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, $dd_t); throw e; }',
                    '    };',
                    '    init();',
                    '  }',
                    '}',
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
                    '  try {',
                    '    let $dd_rv0;',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, {msg}); console.log(msg); ',
                    '    if ($dd_p0) $dd_return($dd_p0, undefined, this, {msg});',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {msg}); throw e; }',
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
                    '  try {',
                    '    let $dd_rv0;',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, {x}); if (x < 0) { return ($dd_rv0 = -x, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {x}) : $dd_rv0); } return ($dd_rv0 = x, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {x}) : $dd_rv0); ',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {x}); throw e; }',
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
                    '  try {',
                    '    let $dd_rv0;',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, {x}); if (!x) { if ($dd_p0) $dd_return($dd_p0, undefined, this, {x}); return; } console.log(x); ',
                    '    if ($dd_p0) $dd_return($dd_p0, undefined, this, {x});',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {x}); throw e; }',
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
                    '  try {',
                    '    let $dd_rv0;',
                    '    if ($dd_p0) $dd_entry($dd_p0, this, {x});',
                    '    if (x > 0) {',
                    '      return ($dd_rv0 = 1, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {x}) : $dd_rv0);',
                    '    } else {',
                    '      return ($dd_rv0 = -1, $dd_p0 ? $dd_return($dd_p0, $dd_rv0, this, {x}) : $dd_rv0);',
                    '    }',
                    '',
                    '  } catch(e) { if ($dd_p0) $dd_throw($dd_p0, e, this, {x}); throw e; }',
                    '}',
                ),
            );
        });
    });
});

interface RuntimeGlobal {
    result: unknown;
}

interface RuntimeSandbox {
    $dd_probes: () => undefined;
    globalThis: RuntimeGlobal;
}

// TODO: Investigate if we can use this in more tests.
function runTransformedFunction(code: string): unknown {
    const runtimeGlobal: RuntimeGlobal = { result: undefined };
    const sandbox: RuntimeSandbox = {
        $dd_probes: () => undefined,
        globalThis: runtimeGlobal,
    };
    const executableCode = `${code}\nglobalThis.result = f();`;
    runInNewContext(executableCode, sandbox);
    return runtimeGlobal.result;
}

function validateSyntax(code: string, filePath: string): string | null {
    try {
        parse(code, {
            sourceType: 'unambiguous',
            plugins: ['jsx', 'typescript'],
            sourceFilename: filePath,
        });
        return null;
    } catch (e: unknown) {
        return e instanceof Error ? e.message : String(e);
    }
}
