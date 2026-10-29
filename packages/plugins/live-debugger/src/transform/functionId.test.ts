// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parse } from '@babel/parser';
import type _traverse from '@babel/traverse';
import type * as t from '@babel/types';

import type { BabelPath } from './babel-path.types';
import { resolveCjsDefaultExport } from './cjs-interop';
import { createFunctionIdGenerator, getFunctionName, parseFunctionId } from './functionId';

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const babelTypes = require('@babel/types') as typeof import('@babel/types');

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const traverse = resolveCjsDefaultExport<typeof _traverse>(require('@babel/traverse'));

const MODULE_PATH = 'src/cart.js';

function parseModule(code: string) {
    return parse(code, {
        sourceType: 'module',
        plugins: ['typescript'],
    });
}

function parseFunctionPaths(code: string): BabelPath<t.Function>[] {
    const ast = parseModule(code);
    const paths: BabelPath<t.Function>[] = [];

    traverse(ast, {
        Function(path) {
            paths.push(path);
        },
    });

    return paths;
}

function parseSingleFunction(code: string): BabelPath<t.Function> {
    const paths = parseFunctionPaths(code);
    if (paths.length === 0) {
        throw new Error(`No function found in: ${code}`);
    }
    return paths[0];
}

// The IDs of all the functions of a module, in source order, generated the way the transform does.
function getFunctionIds(code: string): string[] {
    const ast = parseModule(code);
    const generator = createFunctionIdGenerator(MODULE_PATH, babelTypes);
    const functionIds: string[] = [];

    traverse(ast, {
        Class: {
            enter(path) {
                generator.enterClass(path);
            },
            exit() {
                generator.exit();
            },
        },
        Function: {
            enter(path) {
                const functionId = generator.enterFunction(path);
                functionIds.push(functionId);
            },
            exit() {
                generator.exit();
            },
        },
    });

    return functionIds;
}

// The qualified names of all the functions of a module, without the module path.
function getQualifiedNames(code: string): string[] {
    const functionIds = getFunctionIds(code);
    const prefix = `${MODULE_PATH};`;
    return functionIds.map((functionId) => functionId.slice(prefix.length));
}

describe('getFunctionName', () => {
    describe('named function declarations', () => {
        const cases = [
            {
                description: 'return name from a named function declaration',
                code: 'function foo() {}',
                expected: 'foo',
            },
            {
                description: 'return name from a named function expression',
                code: 'const x = function bar() {};',
                expected: 'bar',
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            expect(getFunctionName(parseSingleFunction(code), babelTypes)).toBe(expected);
        });
    });

    describe('object methods', () => {
        const cases = [
            {
                description: 'return name from an object method',
                code: 'const o = { foo() {} };',
                expected: 'foo',
            },
            {
                description: 'return name from a string-keyed object method',
                code: 'const o = { "my-method"() {} };',
                expected: 'my-method',
            },
            {
                description: 'return name from a numeric-keyed object method',
                code: 'const o = { 42() {} };',
                expected: '42',
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            expect(getFunctionName(parseSingleFunction(code), babelTypes)).toBe(expected);
        });
    });

    describe('class methods', () => {
        const cases = [
            {
                description: 'return name from a class method',
                code: 'class C { foo() {} }',
                expected: 'foo',
            },
            {
                description: 'return name from a static class method',
                code: 'class C { static bar() {} }',
                expected: 'bar',
            },
            {
                description: 'return name from a class private method',
                code: 'class C { #secret() {} }',
                expected: '#secret',
            },
            {
                description: 'return name from a string-keyed class method',
                code: 'class C { "my-method"() {} }',
                expected: 'my-method',
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            expect(getFunctionName(parseSingleFunction(code), babelTypes)).toBe(expected);
        });
    });

    describe('variable declarations', () => {
        const cases = [
            {
                description: 'return name from a const arrow function',
                code: 'const foo = () => {};',
                expected: 'foo',
            },
            {
                description: 'return name from a let function expression',
                code: 'let foo = function() {};',
                expected: 'foo',
            },
            {
                description: 'return name from a var function expression',
                code: 'var foo = function() {};',
                expected: 'foo',
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            expect(getFunctionName(parseSingleFunction(code), babelTypes)).toBe(expected);
        });
    });

    describe('assignment expressions', () => {
        const cases = [
            {
                description: 'return name from an identifier assignment',
                code: 'let foo; foo = () => {};',
                expected: 'foo',
            },
            {
                description: 'return name from a member expression assignment',
                code: 'obj.foo = () => {};',
                expected: 'obj.foo',
            },
            {
                description: 'return name from a this member assignment',
                code: 'this.handler = () => {};',
                expected: 'this.handler',
            },
            {
                description: 'return name from a deep member chain assignment',
                code: 'a.b.c = () => {};',
                expected: 'a.b.c',
            },
            {
                description: 'return null for a computed member assignment',
                code: 'obj[key] = () => {};',
                expected: null,
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            const paths = parseFunctionPaths(code);
            const fnPath = paths[paths.length - 1];
            expect(getFunctionName(fnPath, babelTypes)).toBe(expected);
        });
    });

    describe('object properties', () => {
        const cases = [
            {
                description: 'return name from an identifier-keyed object property',
                code: 'const o = { foo: () => {} };',
                expected: 'foo',
            },
            {
                description: 'return name from a string-keyed object property',
                code: 'const o = { "my-prop": () => {} };',
                expected: 'my-prop',
            },
            {
                description: 'return name from a numeric-keyed object property',
                code: 'const o = { 99: () => {} };',
                expected: '99',
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            expect(getFunctionName(parseSingleFunction(code), babelTypes)).toBe(expected);
        });
    });

    describe('class properties', () => {
        const cases = [
            {
                description: 'return name from a class property',
                code: 'class C { foo = () => {}; }',
                expected: 'foo',
            },
            {
                description: 'return name from a class private property',
                code: 'class C { #foo = () => {}; }',
                expected: '#foo',
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            expect(getFunctionName(parseSingleFunction(code), babelTypes)).toBe(expected);
        });
    });

    describe('anonymous functions', () => {
        const cases = [
            {
                description: 'return null for an anonymous arrow in an array',
                code: 'const arr = [() => {}];',
            },
            {
                description: 'return null for an anonymous arrow passed as argument',
                code: 'foo(() => {});',
            },
            {
                description: 'return null for an IIFE',
                code: '(function() {})();',
            },
        ];

        test.each(cases)('should $description', ({ code }) => {
            expect(getFunctionName(parseSingleFunction(code), babelTypes)).toBeNull();
        });
    });
});

describe('createFunctionIdGenerator', () => {
    test('should prefix the qualified name with the module path', () => {
        expect(getFunctionIds('function add() {}')).toEqual(['src/cart.js;add']);
    });

    describe('qualified names', () => {
        const cases = [
            {
                description: 'qualify methods by their class',
                code: 'class Cart { total() {} static create() {} #secret() {} }',
                expected: ['Cart.total', 'Cart.create', 'Cart.#secret'],
            },
            {
                description: 'mark class getters and setters',
                code: 'class Cart { get size() {} set size(value) {} static get empty() {} }',
                expected: ['Cart.size:get', 'Cart.size:set', 'Cart.empty:get'],
            },
            {
                description: 'mark private getters and setters',
                code: 'class Cart { get #count() {} set #count(value) {} }',
                expected: ['Cart.#count:get', 'Cart.#count:set'],
            },
            {
                description: 'mark object getters and setters',
                code: 'const cart = { get size() {}, set size(value) {} };',
                expected: ['size:get', 'size:set'],
            },
            {
                description: 'qualify class property values by their class',
                code: 'class Cart { handler = () => {}; #onClick = function () {}; static from = () => {}; }',
                expected: ['Cart.handler', 'Cart.#onClick', 'Cart.from'],
            },
            {
                description: 'name a class expression after its variable',
                code: 'const Cart = class { total() {} };',
                expected: ['Cart.total'],
            },
            {
                description: 'name a class expression after its assignment target',
                code: 'exports.Cart = class { total() {} };',
                expected: ['exports.Cart.total'],
            },
            {
                description: 'name a class expression after its object property',
                code: 'const shop = { Cart: class { total() {} } };',
                expected: ['Cart.total'],
            },
            {
                description: 'qualify a class assigned to a static property by its class',
                code: 'class Cart { static Item = class { price() {} }; }',
                expected: ['Cart.Item.price'],
            },
            {
                description: 'qualify functions by the function around them',
                code: 'function doubleAll(items) { return items.map((item) => item * 2); }',
                expected: ['doubleAll', 'doubleAll/<anonymous>'],
            },
            {
                description: 'qualify functions by the method around them',
                code: 'class Cart { total() { return this.items.map(() => 1); } }',
                expected: ['Cart.total', 'Cart.total/<anonymous>'],
            },
            {
                description: 'qualify a class by the function around it',
                code: 'function make() { class Box { open() {} } return Box; }',
                expected: ['make', 'make/Box.open'],
            },
            {
                description:
                    'qualify functions that are part of a class property value by the class',
                code: 'class Cart { handler = debounce(() => {}); static { init(() => {}); } }',
                expected: ['Cart/<anonymous>', 'Cart/<anonymous>#1'],
            },
            {
                description: 'skip anonymous functions around a function',
                code: '[1].forEach(function () { [2].forEach(() => { function helper() {} }); });',
                expected: ['<anonymous>', '<anonymous>#1', 'helper'],
            },
            {
                description: 'skip an immediately invoked function around a function',
                code: '(function () { const init = () => {}; })();',
                expected: ['<anonymous>', 'init'],
            },
            {
                description: 'skip an anonymous class around a method',
                code: 'function make() { return class { open() {} }; }',
                expected: ['make', 'make/open'],
            },
            {
                description: 'skip an anonymous default export class around a method',
                code: 'export default class { total() {} }',
                expected: ['total'],
            },
            {
                description: 'not qualify functions by the object literal around them',
                code: 'function setup() { return { load() {}, save: () => {} }; }',
                expected: ['setup', 'setup/load', 'setup/save'],
            },
            {
                description: 'keep the name of assignment targets',
                code: 'function Cart() { this.total = function () {}; } Cart.prototype.size = function () {};',
                expected: ['Cart', 'Cart/this.total', 'Cart.prototype.size'],
            },
            {
                description: 'name a function without a name anonymous',
                code: 'class Cart { [Symbol.iterator]() {} } export default function () {}',
                expected: ['Cart.<anonymous>', '<anonymous>'],
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            expect(getQualifiedNames(code)).toEqual(expected);
        });
    });

    describe('duplicate names', () => {
        const cases = [
            {
                description: 'number anonymous siblings in source order',
                code: 'foo(() => {}); foo(() => {}); foo(() => {});',
                expected: ['<anonymous>', '<anonymous>#1', '<anonymous>#2'],
            },
            {
                description: 'number functions with the same name in different blocks',
                code: 'if (a) { function f() {} } else { function f() {} }',
                expected: ['f', 'f#1'],
            },
            {
                description: 'number a method and a static method with the same name',
                code: 'class Cart { load() {} static load() {} }',
                expected: ['Cart.load', 'Cart.load#1'],
            },
            {
                description: 'only number functions with the same qualified name',
                code: 'function a() { foo(() => {}); } function b() { foo(() => {}); }',
                expected: ['a', 'a/<anonymous>', 'b', 'b/<anonymous>'],
            },
            {
                description: 'qualify functions by the numbered name of the function around them',
                code: '{ const render = () => () => {}; } { const render = () => () => {}; }',
                expected: ['render', 'render/<anonymous>', 'render#1', 'render#1/<anonymous>'],
            },
            {
                description: 'skip suffixes that another function has as its name',
                code: "const a = { 'f#1'() {} }; const b = { f() {} }; const c = { f() {} };",
                expected: ['f#1', 'f', 'f#2'],
            },
            {
                description: 'number a name that looks like a suffix when it is taken',
                code: "const a = { f() {} }; const b = { f() {} }; const c = { 'f#1'() {} };",
                expected: ['f', 'f#1', 'f#1#1'],
            },
        ];

        test.each(cases)('should $description', ({ code, expected }) => {
            expect(getQualifiedNames(code)).toEqual(expected);
        });
    });

    test('should give every function of a module a different ID', () => {
        const code = `
            export default function () { return () => {}; }
            export function f() {}
            { function f() {} }
            const o = { f() {}, 'f#1'() {}, get f() {}, set f(v) {}, [key]() {}, ['f']() {}, 42: () => {} };
            class A {
                constructor() { this.f = () => {}; }
                f() {}
                static f() {}
                #f() {}
                get f() {}
                set f(v) {}
                static { (() => {})(); }
                f = () => {};
                [Symbol.iterator]() {}
                [Symbol.asyncIterator]() {}
                'quoted name'() {}
            }
            const B = class { f() {} };
            class C extends class { f() {} } { f() { return [1].map(() => [2].map(() => {})); } }
            (function () { function f() {} })();
            (() => { const f = () => {}; })();
            a.b.c = function () {};
            a.b.c = function () {};
            obj[key] = () => {};
            obj[key] = () => {};
        `;
        const functionIds = getFunctionIds(code);
        const uniqueFunctionIds = new Set(functionIds);
        const functionCount = parseFunctionPaths(code).length;

        expect(functionIds).toHaveLength(functionCount);
        expect(uniqueFunctionIds.size).toBe(functionCount);
    });

    describe('edits that keep IDs', () => {
        const cases = [
            {
                description: 'keep IDs when a function body changes',
                before: 'function a() { return 1; }\nfoo(() => 2);',
                after: 'function a() {\n    const one = 1;\n    return one;\n}\nfoo(() => {\n    return 2;\n});',
                expected: {
                    before: ['a', '<anonymous>'],
                    after: ['a', '<anonymous>'],
                },
            },
            {
                description: 'keep IDs when lines are added above',
                before: 'class Cart { total() {} }\nfoo(() => 1);',
                after: "import { x } from 'x';\n\nconsole.log(x);\n\nclass Cart { total() {} }\nfoo(() => 1);",
                expected: {
                    before: ['Cart.total', '<anonymous>'],
                    after: ['Cart.total', '<anonymous>'],
                },
            },
            {
                description: 'keep IDs when functions with other names are added before them',
                before: 'class Cart { get size() {} total() {} }',
                after: 'function helper() {}\nclass Cart { count() {} get size() {} total() {} }',
                expected: {
                    before: ['Cart.size:get', 'Cart.total'],
                    after: ['helper', 'Cart.count', 'Cart.size:get', 'Cart.total'],
                },
            },
            {
                description: 'keep IDs when an anonymous function is added to another function',
                before: 'function a() {}\nfunction b() { foo(() => 2); }',
                after: 'function a() { foo(() => 1); }\nfunction b() { foo(() => 2); }',
                expected: {
                    before: ['a', 'b', 'b/<anonymous>'],
                    after: ['a', 'a/<anonymous>', 'b', 'b/<anonymous>'],
                },
            },
            {
                description: 'keep IDs when an anonymous sibling is added after them',
                before: 'function load() { a.then(() => 1); }',
                after: 'function load() { a.then(() => 1); b.then(() => 2); }',
                expected: {
                    before: ['load', 'load/<anonymous>'],
                    after: ['load', 'load/<anonymous>', 'load/<anonymous>#1'],
                },
            },
            {
                description: 'keep IDs when another function is renamed',
                before: 'function a() {}\nfunction b() { foo(() => {}); }',
                after: 'function renamed() {}\nfunction b() { foo(() => {}); }',
                expected: {
                    before: ['a', 'b', 'b/<anonymous>'],
                    after: ['renamed', 'b', 'b/<anonymous>'],
                },
            },
        ];

        test.each(cases)('should $description', ({ before, after, expected }) => {
            expect(getQualifiedNames(before)).toEqual(expected.before);
            expect(getQualifiedNames(after)).toEqual(expected.after);
        });
    });

    test('should shift the suffix of an anonymous function when a sibling is added before it', () => {
        // Like a move: the callback keeps its name, but not its place among its siblings.
        const before = getQualifiedNames('function load() { a.then(() => 1); }');
        const after = getQualifiedNames('function load() { b.then(() => 0); a.then(() => 1); }');

        expect(before).toEqual(['load', 'load/<anonymous>']);
        expect(after).toEqual(['load', 'load/<anonymous>', 'load/<anonymous>#1']);
    });
});

describe('parseFunctionId', () => {
    const cases = [
        {
            description: 'split a top-level function ID',
            input: 'src/utils.js;add',
            expected: { modulePath: 'src/utils.js', name: 'add' },
        },
        {
            description: 'keep the class of a class member',
            input: 'src/cart.js;Cart.size:get',
            expected: { modulePath: 'src/cart.js', name: 'Cart.size:get' },
        },
        {
            description: 'keep the class of a private method',
            input: 'src/cart.js;Cart.#secret',
            expected: { modulePath: 'src/cart.js', name: 'Cart.#secret' },
        },
        {
            description: 'drop the names of the functions around the function',
            input: 'src/cart.js;Cart.total/doubleAll/<anonymous>',
            expected: { modulePath: 'src/cart.js', name: '<anonymous>' },
        },
        {
            description: 'drop the duplicate suffix',
            input: 'src/cart.js;render#1/double#2',
            expected: { modulePath: 'src/cart.js', name: 'double' },
        },
        {
            description: 'keep separators that are part of the function name',
            input: 'src/utils.js;get;user',
            expected: { modulePath: 'src/utils.js', name: 'get;user' },
        },
        {
            description: 'reject an ID without a module path',
            input: ';add',
            expected: undefined,
        },
        {
            description: 'reject an ID without a separator',
            input: 'add',
            expected: undefined,
        },
    ];

    test.each(cases)('should $description', ({ input, expected }) => {
        expect(parseFunctionId(input)).toEqual(expected);
    });
});
