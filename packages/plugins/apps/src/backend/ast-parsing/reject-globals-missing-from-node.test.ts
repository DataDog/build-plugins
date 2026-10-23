// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { analyzeModuleScope } from '@dd/apps-plugin/backend/ast-parsing/module-scope';
import {
    NODE_REPLACEMENT_HINTS,
    rejectGlobalsMissingFromNode,
} from '@dd/apps-plugin/backend/ast-parsing/reject-globals-missing-from-node';
import { ensureProgram } from '@dd/apps-plugin/backend/ast-parsing/type-guards';
import { NODE_BACKEND_RUNTIME } from '@dd/apps-plugin/constants';
import { parseAst } from 'rollup/parseAst';

describe('Backend Functions - rejectGlobalsMissingFromNode', () => {
    const filePath = '/project/src/math.backend.ts';

    const checkMissingGlobals = (code: string) => {
        const ast = parseAst(code);
        const program = ensureProgram(ast, filePath);
        const scopeAnalysis = analyzeModuleScope(program);
        rejectGlobalsMissingFromNode(ast, filePath, scopeAnalysis);
    };

    const rejectedCases = [
        {
            description: 'reject a bare XMLHttpRequest reference',
            code: 'export async function run() { return new XMLHttpRequest(); }',
        },
        {
            description: 'reject XMLHttpRequest referenced without calling it',
            code: 'export function run() { const f = XMLHttpRequest; return f; }',
        },
        {
            description: 'reject globalThis.XMLHttpRequest(...)',
            code: 'export async function run() { return globalThis.XMLHttpRequest(); }',
        },
        {
            description: 'reject globalThis["XMLHttpRequest"](...)',
            code: 'export async function run() { return globalThis["XMLHttpRequest"](); }',
        },
        {
            description: 'reject destructuring XMLHttpRequest off of globalThis',
            code: 'export function run() { const { XMLHttpRequest } = globalThis; return new XMLHttpRequest(); }',
        },
        {
            description:
                'reject destructuring XMLHttpRequest off of globalThis under a local alias',
            code: 'export function run() { const { XMLHttpRequest: Xhr } = globalThis; return new Xhr(); }',
        },
        {
            description:
                'reject destructuring XMLHttpRequest off of globalThis via a computed string-literal key',
            code: "export function run() { const { ['XMLHttpRequest']: request } = globalThis; return new request(); }",
        },
        {
            description: 'reject global.XMLHttpRequest(...) via the Node global alias',
            code: 'export async function run() { return global.XMLHttpRequest(); }',
        },
        {
            description: 'reject global["XMLHttpRequest"](...) via the Node global alias',
            code: 'export async function run() { return global["XMLHttpRequest"](); }',
        },
        {
            description: 'reject destructuring XMLHttpRequest off of global, the Node global alias',
            code: 'export function run() { const { XMLHttpRequest } = global; return new XMLHttpRequest(); }',
        },
        {
            description: 'reject a destructuring *assignment* (not declaration) off of globalThis',
            code: 'export function run() { let request; ({ XMLHttpRequest: request } = globalThis); return new request(); }',
        },
        {
            description: 'reject a destructuring *assignment* off of global, the Node global alias',
            code: 'export function run() { let request; ({ XMLHttpRequest: request } = global); return new request(); }',
        },
        {
            description:
                'reject globalThis[`XMLHttpRequest`](...) via a no-substitution template-literal key',
            code: 'export async function run() { return globalThis[`XMLHttpRequest`](); }',
        },
        {
            description:
                'reject destructuring XMLHttpRequest off of globalThis via a template-literal key',
            code: 'export function run() { const { [`XMLHttpRequest`]: request } = globalThis; return new request(); }',
        },
        {
            description:
                'reject destructuring XMLHttpRequest off of globalThis via a quoted (non-computed) string-literal key',
            code: "export function run() { const { 'XMLHttpRequest': request } = globalThis; return new request(); }",
        },
        {
            description:
                'reject destructuring XMLHttpRequest off of globalThis via a function parameter default value',
            code: 'export function run({ XMLHttpRequest } = globalThis) { return new XMLHttpRequest(); }',
        },
        {
            description: 'reject XMLHttpRequest reached through a single const alias of globalThis',
            code: 'export function run() { const g = globalThis; return g.XMLHttpRequest(); }',
        },
        {
            description: 'reject a destructure off of a single const alias of globalThis',
            code: 'export function run() { const g = globalThis; const { XMLHttpRequest } = g; return new XMLHttpRequest(); }',
        },
        {
            description:
                'reject XMLHttpRequest reached through a chain of const aliases of globalThis',
            code: 'export function run() { const g1 = globalThis; const g2 = g1; return g2.XMLHttpRequest(); }',
        },
        {
            description:
                'reject globalThis.globalThis.XMLHttpRequest(...), a self-referential member-expression chain',
            code: 'export function run() { return globalThis.globalThis.XMLHttpRequest(); }',
        },
        {
            description:
                "reject global.global.XMLHttpRequest(...), the Node alias's own self-referential chain",
            code: 'export function run() { return global.global.XMLHttpRequest(); }',
        },
        {
            description:
                'reject XMLHttpRequest reached through a nested destructure of the self-referential globalThis.globalThis',
            code: 'export function run() { const { globalThis: { XMLHttpRequest } } = globalThis; return new XMLHttpRequest(); }',
        },
        {
            description:
                'reject XMLHttpRequest reached through a const alias bound by a self-referential globalThis destructure key',
            code: 'export function run() { const { globalThis: g } = globalThis; return g.XMLHttpRequest(); }',
        },
        {
            description:
                "reject XMLHttpRequest reached through a const alias bound by a self-referential global destructure key (Node's own alias)",
            code: 'export function run() { const { global: g } = global; return g.XMLHttpRequest(); }',
        },
        {
            description:
                'reject XMLHttpRequest reached through a const alias bound by a self-referential globalThis destructure key that also carries a default value',
            code: 'export function run() { const { globalThis: g = {} } = globalThis; return g.XMLHttpRequest(); }',
        },
        {
            description:
                'reject XMLHttpRequest reached through a const alias bound by two levels of self-referential globalThis destructure keys',
            code: 'export function run() { const { globalThis: { globalThis: g } } = globalThis; return g.XMLHttpRequest(); }',
        },
        {
            description:
                'reject XMLHttpRequest reached through a nested destructure of the self-referential globalThis.globalThis when the outer key carries a default value',
            code: 'export function run() { const { globalThis: { XMLHttpRequest } = {} } = globalThis; return new XMLHttpRequest(); }',
        },
        {
            description:
                'reject XMLHttpRequest reached through a for-of destructure whose inline iterable array literal contains globalThis',
            code: 'export function run() { for (const { XMLHttpRequest } of [globalThis]) { return new XMLHttpRequest(); } }',
        },
        {
            description:
                'reject XMLHttpRequest reached through a for-of destructure whose inline iterable array literal contains a const alias of globalThis',
            code: 'export function run() { const g = globalThis; for (const { XMLHttpRequest } of [g]) { return new XMLHttpRequest(); } }',
        },
        {
            description:
                'reject XMLHttpRequest reached through a plain (non-destructured) for-of loop variable bound to globalThis via an inline array literal',
            code: 'export function run() { for (const g of [globalThis]) { return g.XMLHttpRequest(); } }',
        },
        {
            description:
                'reject XMLHttpRequest reached through a for-of loop using an assignment target (no const/let) destructuring globalThis via an inline array literal',
            code: 'export function run() { let XMLHttpRequest; for ({ XMLHttpRequest } of [globalThis]) { return new XMLHttpRequest(); } }',
        },
        {
            description:
                'reject globalThis[f](...) where f is a const alias of a string-literal property name',
            code: "export function run() { const f = 'XMLHttpRequest'; return globalThis[f](); }",
        },
        {
            description:
                'reject destructuring XMLHttpRequest off of globalThis via a computed key that is a const alias of a string-literal property name',
            code: "export function run() { const key = 'XMLHttpRequest'; const { [key]: r } = globalThis; return new r(); }",
        },
        {
            description:
                'reject XMLHttpRequest reached through a chain of const aliases resolving a computed property name',
            code: "export function run() { const f1 = 'XMLHttpRequest'; const f2 = f1; return globalThis[f2](); }",
        },
        {
            description: 'reject new EventSource(...)',
            code: 'export function run() { return new EventSource("/events"); }',
        },
        {
            description: 'reject globalThis.EventSource',
            code: 'export function run() { return new globalThis.EventSource("/events"); }',
        },
        {
            description: 'reject Deno.env.get(...)',
            code: 'export function run() { return Deno.env.get("TOKEN"); }',
        },
        {
            description: 'reject globalThis.Deno',
            code: 'export function run() { return globalThis.Deno.version; }',
        },
        {
            description: 'reject destructuring off of Deno',
            code: 'export function run() { const { env } = Deno; return env.get("TOKEN"); }',
        },
        {
            description: 'reject a bare Deno as an if test, which throws a ReferenceError on Node',
            code: 'export function run() { if (Deno) { return 1; } return 2; }',
        },
        {
            description: 'reject an assignment of a bare Deno inside a test',
            code: 'let d; export function run() { return (d = Deno) == null; }',
        },
        {
            description:
                'reject an optional call on a bare Deno, which still throws a ReferenceError',
            code: 'export function run() { return Deno?.cwd(); }',
        },
        {
            description: 'reject typeof of a Deno member, which reads Deno first',
            code: 'export function run() { return typeof Deno.env; }',
        },
        {
            description: 'reject using globalThis.Deno after checking for it',
            code: 'export function run() { if (globalThis.Deno) { return globalThis.Deno.cwd(); } return 2; }',
        },
        {
            description: 'reject constructing globalThis.EventSource',
            code: 'export function run(url) { return new globalThis.EventSource(url); }',
        },
        {
            description: 'reject assigning a member of globalThis.Deno, which reads Deno first',
            code: 'export function run(f) { globalThis.Deno.cwd = f; }',
        },
        {
            description: 'reject reading a global after installing a polyfill on it',
            code: 'export function run(P, url) { globalThis.EventSource = P; return new globalThis.EventSource(url); }',
        },
        {
            description: 'reject dereferencing a parenthesized optional chain on a missing global',
            code: 'export function run() { return (globalThis.Deno?.env).get("X"); }',
        },
        {
            description: 'reject dereferencing an optional member of globalThis itself',
            code: 'export function run() { return globalThis?.Deno.cwd(); }',
        },
        {
            description: 'reject dereferencing a const alias of a missing global',
            code: 'export function run() { const d = globalThis.Deno; return d.env.get("X"); }',
        },
        {
            description: 'reject destructuring a missing global',
            code: 'export function run() { const { env } = globalThis.Deno; return env; }',
        },
        {
            description: 'reject a nested destructure of a missing global',
            code: 'export function run() { const { Deno: { env } } = globalThis; return env; }',
        },
        {
            description: 'reject extending a missing global',
            code: 'export class SSE extends globalThis.EventSource {}',
        },
        {
            description: 'reject iterating or spreading a missing global',
            code: 'export function run() { for (const x of globalThis.Deno) {} return [...globalThis.Deno]; }',
        },
        {
            description: 'reject spreading a missing global into a call',
            code: 'export function run(f) { return f(...globalThis.Deno); }',
        },
        {
            description: 'reject a missing global on the right of instanceof',
            code: 'export function run(e) { return e instanceof globalThis.XMLHttpRequest; }',
        },
        {
            description: 'reject a missing global on the right of in',
            code: 'export function run() { return "k" in globalThis.Deno; }',
        },
        {
            description: 'reject a missing global used as a template tag',
            code: 'export function run() { return globalThis.Deno`x`; }',
        },
    ];

    test.each(rejectedCases)('Should $description', ({ code }) => {
        expect(() => checkMissingGlobals(code)).toThrow(
            `is not available in the ${NODE_BACKEND_RUNTIME}`,
        );
        expect(() => checkMissingGlobals(code)).toThrow(filePath);
    });

    test('Should suggest fetch or importing a polyfill by name', () => {
        expect(() =>
            checkMissingGlobals('export function run() { return new EventSource("/events"); }'),
        ).toThrow(NODE_REPLACEMENT_HINTS.EventSource);
    });

    test('Should suggest a Node API for Deno, not fetch or a polyfill', () => {
        const run = () => checkMissingGlobals('export function run() { return Deno.cwd(); }');

        expect(run).toThrow(NODE_REPLACEMENT_HINTS.Deno);
        expect(run).toThrow(
            expect.objectContaining({ message: expect.not.stringContaining('fetch') }),
        );
        expect(run).toThrow(
            expect.objectContaining({ message: expect.not.stringContaining('polyfill') }),
        );
    });

    const allowedCases = [
        {
            description: 'allow calling an imported action-catalog function',
            code: "import { request } from '@datadog/action-catalog/http/http';\nexport async function run() { return request({ inputs: {} }); }",
        },
        {
            description:
                'allow a locally-declared function that happens to be named XMLHttpRequest',
            code: 'function XMLHttpRequest() { return "local"; }\nexport function run() { return new XMLHttpRequest(); }',
        },
        {
            description: 'allow a parameter named XMLHttpRequest shadowing the global',
            code: 'export function run(XMLHttpRequest) { return new XMLHttpRequest(); }',
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
                'allow a nested destructure named XMLHttpRequest whose outer key is not itself a globalThis/global self-reference, since the outer key is not provably an alias back to the ambient global',
            code: 'export function run() { const { myApi: { XMLHttpRequest } } = globalThis; return XMLHttpRequest; }',
        },
        {
            description:
                'allow accessing .XMLHttpRequest on a parameter named globalThis shadowing the ambient global',
            code: 'export function run(globalThis) { return globalThis.XMLHttpRequest(); }',
        },
        {
            description:
                'allow destructuring XMLHttpRequest off of a parameter named globalThis shadowing the ambient global',
            code: 'export function run(globalThis) { const { XMLHttpRequest } = globalThis; return new XMLHttpRequest(); }',
        },
        {
            description:
                'allow accessing .XMLHttpRequest on a parameter named global shadowing the Node alias',
            code: 'export function run(global) { return global.XMLHttpRequest(); }',
        },
        {
            description:
                'allow a destructuring assignment off of a parameter named globalThis shadowing the ambient global',
            code: 'export function run(globalThis) { let request; ({ XMLHttpRequest: request } = globalThis); return request(); }',
        },
        {
            description:
                'allow a "let" alias of globalThis, since it could be reassigned to something else',
            code: 'export function run() { let g = globalThis; return g.XMLHttpRequest(); }',
        },
        {
            description:
                'allow a function-parameter default value aliasing globalThis, same opacity as a "let" alias',
            code: 'export function run(g = globalThis) { return g.XMLHttpRequest(); }',
        },
        {
            description:
                'allow a "let"-declared for-of loop variable bound to globalThis via an inline array literal, since it could be reassigned to something else before use, same opacity as a "let" alias',
            code: 'export function run() { for (let g of [globalThis]) { g = safeObj; return g.XMLHttpRequest(); } }',
        },
        {
            description: 'allow a computed member access with a template literal that interpolates',
            // eslint-disable-next-line no-template-curly-in-string -- source text for the AST under test, not a real interpolation
            code: 'export function run(name) { return globalThis[`${name}`](); }',
        },
        {
            description:
                'allow accessing a property on a destructured binding of globalThis, since the binding is a specific property value, not the ambient global object itself',
            code: 'export function run() { const { console: g } = globalThis; return g.XMLHttpRequest; }',
        },
        {
            description:
                'allow a computed property access whose key is a "let" alias of a string literal, same opacity as a "let" alias of globalThis itself',
            code: "export function run() { let f = 'XMLHttpRequest'; return globalThis[f](); }",
        },
        {
            description:
                'allow a computed property access whose key is a mutually self-referential const cycle, since the key cannot be statically resolved',
            code: 'export function run() { const a = b; const b = a; return globalThis[a](); }',
        },
        {
            description: 'allow fetch, which Node provides',
            code: 'export async function run() { return fetch("https://example.com"); }',
        },
        {
            description: 'allow WebSocket, which Node provides',
            code: 'export function run() { return new WebSocket("wss://example.com"); }',
        },
        {
            description: 'allow an imported EventSource polyfill, which binds the name locally',
            code: "import { EventSource } from 'eventsource';\nexport function run() { return new EventSource('/events'); }",
        },
        {
            description: 'allow a local binding named Deno',
            code: 'const Deno = { cwd: () => "/" };\nexport function run() { return Deno.cwd(); }',
        },
        {
            description:
                'allow copying every property of globalThis, which the check does not follow',
            code: 'export function run() { const { ...all } = globalThis; return all; }',
        },
        {
            description: 'allow spreading globalThis into a new object',
            code: 'export function run() { return { ...globalThis }; }',
        },
        {
            description: 'allow Object.assign and Object.values over globalThis',
            code: 'export function run() { return [Object.assign({}, globalThis), Object.values(globalThis)]; }',
        },
        {
            description: 'allow typeof Deno feature detection',
            code: "export function run() { return typeof Deno !== 'undefined' ? 'deno' : 'node'; }",
        },
        {
            description: 'allow typeof XMLHttpRequest and typeof EventSource feature detection',
            code: 'export function run() { return [typeof XMLHttpRequest, typeof EventSource]; }',
        },
        {
            description: 'allow typeof globalThis.Deno feature detection',
            code: "export function run() { return typeof globalThis.Deno === 'undefined'; }",
        },
        {
            description: 'allow globalThis.Deno as an if test',
            code: 'export function run() { if (globalThis.Deno) { return 1; } return 2; }',
        },
        {
            description: 'allow globalThis.EventSource as a conditional test',
            code: 'export function run() { return globalThis.EventSource ? 1 : 2; }',
        },
        {
            description: 'allow negating globalThis.XMLHttpRequest',
            code: 'export function run() { return !globalThis.XMLHttpRequest; }',
        },
        {
            description: 'allow globalThis.Deno as the left side of a logical expression',
            code: 'export function run(fallback) { return globalThis.Deno ?? fallback; }',
        },
        {
            description: 'allow comparing globalThis.Deno with undefined',
            code: 'export function run() { return globalThis.Deno === undefined; }',
        },
        {
            description: 'allow optional-chained feature checks on globalThis',
            code: 'export function run() { return [typeof globalThis?.Deno, !globalThis?.XMLHttpRequest, globalThis?.EventSource ? 1 : 2]; }',
        },
        {
            description: 'allow an optional-chained globalThis member as an if test',
            code: 'export function run() { if (globalThis?.EventSource) { return 1; } return 2; }',
        },
        {
            description: 'allow globalThis members on either side of && or || in a test',
            code: 'export function run(a) { if (a && globalThis.EventSource) { return 1; } return globalThis.WebSocket || globalThis.EventSource ? 2 : 3; }',
        },
        {
            description:
                'allow an optional member access on a missing global, which yields undefined',
            code: 'export function run() { return [globalThis.Deno?.version?.deno, typeof globalThis.Deno?.version, globalThis.Deno?.env.get("X")]; }',
        },
        {
            description: 'allow a switch on, or a Boolean() of, a globalThis member',
            code: 'export function run() { switch (globalThis.EventSource) { case undefined: return Boolean(globalThis.XMLHttpRequest); default: return 1; } }',
        },
        {
            description: "allow an 'in' check on globalThis",
            code: "export function run() { return 'Deno' in globalThis; }",
        },
        {
            description:
                'allow ?. and ?? feature checks after a lower esbuild target rewrites them',
            code: 'var _a, _b, _c; export function run() { return [(_a = globalThis.Deno) == null ? void 0 : _a.env, (_b = globalThis.EventSource) != null ? _b : Object, void 0 === (_c = globalThis.Deno)]; }',
        },
        {
            description: 'allow installing a polyfill on globalThis after checking for it',
            code: "import { EventSource as P } from 'eventsource'; export function run() { if (!globalThis.EventSource) { globalThis.EventSource = P; } }",
        },
        {
            description: 'allow assigning XMLHttpRequest on globalThis',
            code: 'export function run(P) { globalThis.XMLHttpRequest = P; }',
        },
        {
            description: 'allow installing a polyfill with ??= or ||=',
            code: 'export function run(P) { globalThis.EventSource ??= P; global.XMLHttpRequest ||= P; }',
        },
        {
            description: 'allow reading a missing global into a binding without using it',
            code: 'export function run() { const f = globalThis.XMLHttpRequest; return f; }',
        },
        {
            description: 'allow testing a const alias or destructured binding of a missing global',
            code: 'export function run() { const d = globalThis.Deno; const { EventSource } = globalThis; return [d ? 1 : 2, !EventSource]; }',
        },
        {
            description: 'allow a destructuring default that fills a missing global',
            code: 'export function run(P, url) { const { EventSource = P } = globalThis; return new EventSource(url); }',
        },
        {
            description:
                'allow dereferencing a reassigned binding, which may no longer hold the global',
            code: 'export function run(shim) { let d = globalThis.Deno; d = shim; return d.cwd(); }',
        },
        {
            description: 'allow spreading a missing global into an object literal',
            code: 'export function run() { const { Deno } = globalThis; return [{ ...globalThis.Deno?.env }, { ...Deno }]; }',
        },
        {
            description: 'allow deleting a missing global',
            code: 'export function run() { delete globalThis.Deno; }',
        },
        {
            description: 'allow a missing global as a switch case',
            code: 'export function run(x) { switch (x) { case globalThis.EventSource: return 1; default: return 2; } }',
        },
        {
            description: 'allow installing a polyfill with &&=',
            code: 'export function run(P) { globalThis.EventSource &&= P; }',
        },
        {
            description: 'allow globalThis?.X after a lower esbuild target rewrites it',
            code: 'export function run() { return globalThis == null ? void 0 : globalThis.Deno; }',
        },
        {
            description:
                'allow, as an accepted gap, a missing global assigned after its declaration',
            code: 'let d; export function run() { d = globalThis.Deno; return d.cwd(); }',
        },
    ];

    test.each(allowedCases)('Should $description', ({ code }) => {
        expect(() => checkMissingGlobals(code)).not.toThrow();
    });
});
