// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rejectRestrictedGlobals } from '@dd/apps-plugin/backend/ast-parsing/reject-restricted-globals';
import { parseAst } from 'rollup/parseAst';

describe('Backend Functions - rejectRestrictedGlobals', () => {
    const filePath = '/project/src/math.backend.ts';

    const rejectedCases = [
        {
            description: 'reject a bare fetch() call',
            code: 'export async function run() { return fetch("https://example.com"); }',
        },
        {
            description: 'reject fetch referenced without calling it',
            code: 'export function run() { const f = fetch; return f; }',
        },
        {
            description: 'reject new XMLHttpRequest()',
            code: 'export function run() { return new XMLHttpRequest(); }',
        },
        {
            description: 'reject new WebSocket(...)',
            code: 'export function run() { return new WebSocket("wss://example.com"); }',
        },
        {
            description: 'reject new EventSource(...)',
            code: 'export function run() { return new EventSource("/events"); }',
        },
        {
            description: 'reject globalThis.fetch(...)',
            code: 'export async function run() { return globalThis.fetch("https://example.com"); }',
        },
        {
            description: 'reject globalThis.fetch referenced without calling it',
            code: 'export function run() { const f = globalThis.fetch; return f; }',
        },
        {
            description: 'reject globalThis["fetch"](...)',
            code: 'export async function run() { return globalThis["fetch"]("https://example.com"); }',
        },
        {
            description: 'reject destructuring fetch off of globalThis',
            code: 'export function run() { const { fetch } = globalThis; return fetch("https://example.com"); }',
        },
        {
            description: 'reject destructuring fetch off of globalThis under a local alias',
            code: 'export function run() { const { fetch: doFetch } = globalThis; return doFetch("https://example.com"); }',
        },
        {
            description:
                'reject destructuring fetch off of globalThis via a computed string-literal key',
            code: "export function run() { const { ['fetch']: request } = globalThis; return request('https://example.com'); }",
        },
        {
            description: 'reject global.fetch(...) via the Node global alias',
            code: 'export async function run() { return global.fetch("https://example.com"); }',
        },
        {
            description: 'reject global["fetch"](...) via the Node global alias',
            code: 'export async function run() { return global["fetch"]("https://example.com"); }',
        },
        {
            description: 'reject destructuring fetch off of global, the Node global alias',
            code: 'export function run() { const { fetch } = global; return fetch("https://example.com"); }',
        },
        {
            description: 'reject a destructuring *assignment* (not declaration) off of globalThis',
            code: 'export function run() { let request; ({ fetch: request } = globalThis); return request("https://example.com"); }',
        },
        {
            description: 'reject a destructuring *assignment* off of global, the Node global alias',
            code: 'export function run() { let request; ({ fetch: request } = global); return request("https://example.com"); }',
        },
        {
            description:
                'reject a rest-destructure of globalThis, which copies every ambient global',
            code: 'export function run() { const { ...globals } = globalThis; return globals.fetch("https://example.com"); }',
        },
        {
            description: 'reject a rest-destructure of global, the Node global alias',
            code: 'export function run() { const { ...globals } = global; return globals.fetch("https://example.com"); }',
        },
        {
            description:
                'reject spreading globalThis into a new object, which copies every ambient global',
            code: 'export function run() { const stolen = { ...globalThis }; return stolen.fetch("https://example.com"); }',
        },
        {
            description: 'reject spreading global into a new object, the Node global alias',
            code: 'export function run() { const stolen = { ...global }; return stolen.fetch("https://example.com"); }',
        },
        {
            description: 'reject Object.assign copying every ambient global into a new object',
            code: 'export function run() { const stolen = Object.assign({}, globalThis); return stolen.fetch("https://example.com"); }',
        },
        {
            description: 'reject Object.assign targeting global, the Node global alias',
            code: 'export function run() { const stolen = Object.assign({}, global); return stolen.fetch("https://example.com"); }',
        },
        {
            description: 'reject Object.values reading every ambient global value at once',
            code: 'export function run() { const values = Object.values(globalThis); return values.find((v) => typeof v === "function")(); }',
        },
        {
            description: 'reject Object.entries reading every ambient global at once',
            code: 'export function run() { const entries = Object.entries(globalThis); return entries[0][1](); }',
        },
        {
            description:
                'reject Object.getOwnPropertyDescriptors reading every ambient global descriptor at once',
            code: 'export function run() { const descriptors = Object.getOwnPropertyDescriptors(globalThis); return descriptors.fetch.value(); }',
        },
        {
            description:
                'reject globalThis[`fetch`](...) via a no-substitution template-literal key',
            code: 'export async function run() { return globalThis[`fetch`]("https://example.com"); }',
        },
        {
            description: 'reject destructuring fetch off of globalThis via a template-literal key',
            code: "export function run() { const { [`fetch`]: request } = globalThis; return request('https://example.com'); }",
        },
        {
            description:
                'reject destructuring fetch off of globalThis via a quoted (non-computed) string-literal key',
            code: "export function run() { const { 'fetch': request } = globalThis; return request('https://example.com'); }",
        },
        {
            description:
                'reject destructuring fetch off of globalThis via a function parameter default value',
            code: 'export function run({ fetch } = globalThis) { return fetch("https://example.com"); }',
        },
        {
            description: 'reject fetch reached through a single const alias of globalThis',
            code: 'export function run() { const g = globalThis; return g.fetch("https://example.com"); }',
        },
        {
            description: 'reject a destructure off of a single const alias of globalThis',
            code: 'export function run() { const g = globalThis; const { fetch } = g; return fetch("https://example.com"); }',
        },
        {
            description: 'reject fetch reached through a chain of const aliases of globalThis',
            code: 'export function run() { const g1 = globalThis; const g2 = g1; return g2.fetch("https://example.com"); }',
        },
        {
            description:
                'reject globalThis.globalThis.fetch(...), a self-referential member-expression chain',
            code: 'export function run() { return globalThis.globalThis.fetch("https://example.com"); }',
        },
        {
            description:
                "reject global.global.fetch(...), the Node alias's own self-referential chain",
            code: 'export function run() { return global.global.fetch("https://example.com"); }',
        },
        {
            description:
                'reject fetch reached through a nested destructure of the self-referential globalThis.globalThis',
            code: 'export function run() { const { globalThis: { fetch } } = globalThis; return fetch("https://example.com"); }',
        },
        {
            description:
                'reject fetch reached through a const alias bound by a self-referential globalThis destructure key',
            code: 'export function run() { const { globalThis: g } = globalThis; return g.fetch("https://example.com"); }',
        },
        {
            description:
                "reject fetch reached through a const alias bound by a self-referential global destructure key (Node's own alias)",
            code: 'export function run() { const { global: g } = global; return g.fetch("https://example.com"); }',
        },
        {
            description:
                'reject fetch reached through a const alias bound by a self-referential globalThis destructure key that also carries a default value',
            code: 'export function run() { const { globalThis: g = {} } = globalThis; return g.fetch("https://example.com"); }',
        },
        {
            description:
                'reject fetch reached through a nested destructure of the self-referential globalThis.globalThis when the outer key carries a default value',
            code: 'export function run() { const { globalThis: { fetch } = {} } = globalThis; return fetch("https://example.com"); }',
        },
        {
            description:
                'reject fetch reached through a for-of destructure whose inline iterable array literal contains globalThis',
            code: 'export function run() { for (const { fetch } of [globalThis]) { return fetch("https://example.com"); } }',
        },
        {
            description:
                'reject fetch reached through a for-of destructure whose inline iterable array literal contains a const alias of globalThis',
            code: 'export function run() { const g = globalThis; for (const { fetch } of [g]) { return fetch("https://example.com"); } }',
        },
        {
            description:
                'reject fetch reached through a plain (non-destructured) for-of loop variable bound to globalThis via an inline array literal',
            code: 'export function run() { for (const g of [globalThis]) { return g.fetch("https://example.com"); } }',
        },
        {
            description:
                'reject fetch reached through a for-of loop using an assignment target (no const/let) destructuring globalThis via an inline array literal',
            code: 'export function run() { let fetch; for ({ fetch } of [globalThis]) { return fetch("https://example.com"); } }',
        },
    ];

    test.each(rejectedCases)('Should $description', ({ code }) => {
        const ast = parseAst(code);
        expect(() => rejectRestrictedGlobals(ast, filePath)).toThrow(
            /is not supported in backend function code/,
        );
        expect(() => rejectRestrictedGlobals(ast, filePath)).toThrow(filePath);
    });

    const allowedCases = [
        {
            description: 'allow calling an imported action-catalog function',
            code: "import { request } from '@datadog/action-catalog/http/http';\nexport async function run() { return request({ inputs: {} }); }",
        },
        {
            description: 'allow a locally-declared function that happens to be named fetch',
            code: 'function fetch() { return "local"; }\nexport function run() { return fetch(); }',
        },
        {
            description: 'allow a parameter named fetch shadowing the global',
            code: 'export function run(fetch) { return fetch(); }',
        },
        {
            description: 'allow unrelated code with no restricted-global references',
            code: 'export function run(a, b) { return a + b; }',
        },
        {
            description: 'allow accessing an unrestricted globalThis property',
            code: 'export function run() { return globalThis.console; }',
        },
        {
            description: 'allow destructuring an unrestricted property off of globalThis',
            code: 'export function run() { const { console } = globalThis; return console; }',
        },
        {
            description:
                'allow a nested destructure named fetch whose outer key is not itself a globalThis/global self-reference, since the outer key is not provably an alias back to the ambient global',
            code: 'export function run() { const { myApi: { fetch } } = globalThis; return fetch; }',
        },
        {
            description:
                'allow accessing .fetch on a parameter named globalThis shadowing the ambient global',
            code: 'export function run(globalThis) { return globalThis.fetch(); }',
        },
        {
            description:
                'allow destructuring fetch off of a parameter named globalThis shadowing the ambient global',
            code: 'export function run(globalThis) { const { fetch } = globalThis; return fetch(); }',
        },
        {
            description:
                'allow accessing .fetch on a parameter named global shadowing the Node alias',
            code: 'export function run(global) { return global.fetch(); }',
        },
        {
            description:
                'allow a destructuring assignment off of a parameter named globalThis shadowing the ambient global',
            code: 'export function run(globalThis) { let request; ({ fetch: request } = globalThis); return request(); }',
        },
        {
            description:
                'allow a rest-destructure of a parameter named globalThis shadowing the ambient global',
            code: 'export function run(globalThis) { const { ...rest } = globalThis; return rest; }',
        },
        {
            description:
                'allow a "let" alias of globalThis, since it could be reassigned to something else',
            code: 'export function run() { let g = globalThis; return g.fetch(); }',
        },
        {
            description:
                'allow a function-parameter default value aliasing globalThis, same opacity as a "let" alias',
            code: 'export function run(g = globalThis) { return g.fetch(); }',
        },
        {
            description:
                'allow a "let"-declared for-of loop variable bound to globalThis via an inline array literal, since it could be reassigned to something else before use, same opacity as a "let" alias',
            code: 'export function run() { for (let g of [globalThis]) { g = safeObj; return g.fetch(); } }',
        },
        {
            description: 'allow a computed member access with a template literal that interpolates',
            // eslint-disable-next-line no-template-curly-in-string -- source text for the AST under test, not a real interpolation
            code: 'export function run(name) { return globalThis[`${name}`](); }',
        },
        {
            description:
                'allow accessing a property on a destructured binding of globalThis, since the binding is a specific property value, not the ambient global object itself',
            code: 'export function run() { const { console: g } = globalThis; return g.fetch; }',
        },
        {
            description:
                'allow Object.assign copying an unrelated object, since the source is not the ambient global',
            code: 'export function run() { const merged = Object.assign({}, { a: 1 }); return merged; }',
        },
        {
            description:
                'allow Object.assign(globalThis, ...), since globalThis there is the write target, not a source being copied from',
            code: 'export function run() { Object.assign(globalThis, { marker: true }); }',
        },
        {
            description:
                'allow Object.keys on a parameter named globalThis shadowing the ambient global',
            code: 'export function run(globalThis) { return Object.keys(globalThis); }',
        },
        {
            description:
                'allow Object.keys(globalThis), since it returns only property-name strings, never a callable reference',
            code: 'export function run() { const names = Object.keys(globalThis); return names.length; }',
        },
        {
            description:
                'allow Reflect.ownKeys(globalThis), since it returns only property-name strings, never a callable reference',
            code: 'export function run() { const keys = Reflect.ownKeys(globalThis); return keys.length; }',
        },
    ];

    test.each(allowedCases)('Should $description', ({ code }) => {
        const ast = parseAst(code);
        expect(() => rejectRestrictedGlobals(ast, filePath)).not.toThrow();
    });
});
