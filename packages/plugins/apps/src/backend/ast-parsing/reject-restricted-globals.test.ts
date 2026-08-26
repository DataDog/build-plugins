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
    ];

    test.each(rejectedCases)('Should $description', ({ code }) => {
        const ast = parseAst(code);
        expect(() => rejectRestrictedGlobals(ast, filePath)).toThrow(
            'is not supported in .backend.ts files',
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
    ];

    test.each(allowedCases)('Should $description', ({ code }) => {
        const ast = parseAst(code);
        expect(() => rejectRestrictedGlobals(ast, filePath)).not.toThrow();
    });
});
