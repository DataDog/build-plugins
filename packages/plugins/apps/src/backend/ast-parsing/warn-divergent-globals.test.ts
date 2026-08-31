// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    resetDivergentGlobalWarnings,
    warnAboutDivergentGlobals,
} from '@dd/apps-plugin/backend/ast-parsing/warn-divergent-globals';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import { parseAst } from 'rollup/parseAst';

describe('Backend Functions - warnAboutDivergentGlobals', () => {
    const filePath = '/project/src/math.backend.ts';

    // Reset so an earlier test's warning doesn't suppress this test's expected warning via the cross-call dedup cache.
    beforeEach(() => {
        resetDivergentGlobalWarnings();
    });

    const warnedCases = [
        {
            description: 'warn on a bare crypto.randomUUID() call',
            code: 'export function run() { return crypto.randomUUID(); }',
            global: 'crypto',
        },
        {
            description: 'warn on crypto referenced without calling it',
            code: 'export function run() { const c = crypto; return c; }',
            global: 'crypto',
        },
        {
            description: 'warn on a bare new Intl.NumberFormat(...)',
            code: 'export function run() { return new Intl.NumberFormat("en-US"); }',
            global: 'Intl',
        },
        {
            description: 'warn on globalThis.crypto',
            code: 'export function run() { return globalThis.crypto.randomUUID(); }',
            global: 'crypto',
        },
        {
            description: 'warn on globalThis["Intl"]',
            code: 'export function run() { return globalThis["Intl"].NumberFormat; }',
            global: 'Intl',
        },
        {
            description: 'warn on destructuring crypto off of globalThis',
            code: 'export function run() { const { crypto } = globalThis; return crypto.randomUUID(); }',
            global: 'crypto',
        },
        {
            description: 'warn on destructuring Intl off of globalThis under a local alias',
            code: 'export function run() { const { Intl: I } = globalThis; return I.NumberFormat; }',
            global: 'Intl',
        },
        {
            description: 'warn on global.crypto via the Node global alias',
            code: 'export function run() { return global.crypto.randomUUID(); }',
            global: 'crypto',
        },
        {
            description: 'warn on global["Intl"] via the Node global alias',
            code: 'export function run() { return global["Intl"].NumberFormat; }',
            global: 'Intl',
        },
        {
            description: 'warn on destructuring crypto off of global, the Node global alias',
            code: 'export function run() { const { crypto } = global; return crypto.randomUUID(); }',
            global: 'crypto',
        },
        {
            description: 'warn on a destructuring *assignment* (not declaration) off of globalThis',
            code: 'export function run() { let c; ({ crypto: c } = globalThis); return c.randomUUID(); }',
            global: 'crypto',
        },
        {
            description: 'warn on globalThis[`crypto`] via a no-substitution template-literal key',
            code: 'export function run() { return globalThis[`crypto`].randomUUID(); }',
            global: 'crypto',
        },
        {
            description: 'warn on crypto reached through a single const alias of globalThis',
            code: 'export function run() { const g = globalThis; return g.crypto.randomUUID(); }',
            global: 'crypto',
        },
        {
            description:
                'warn on destructuring crypto off of globalThis via a function parameter default value',
            code: 'export function run({ crypto } = globalThis) { return crypto.randomUUID(); }',
            global: 'crypto',
        },
        {
            description:
                'warn on crypto reached through a nested destructure of the self-referential globalThis.globalThis',
            code: 'export function run() { const { globalThis: { crypto } } = globalThis; return crypto.randomUUID(); }',
            global: 'crypto',
        },
        {
            description:
                'warn on crypto reached through a const alias bound by a self-referential globalThis destructure key',
            code: 'export function run() { const { globalThis: g } = globalThis; return g.crypto.randomUUID(); }',
            global: 'crypto',
        },
        {
            description:
                'warn on globalThis[key] where key is a const alias of a string-literal property name',
            code: "export function run() { const key = 'crypto'; return globalThis[key].randomUUID(); }",
            global: 'crypto',
        },
    ];

    test.each(warnedCases)('Should $description', ({ code, global }) => {
        const ast = parseAst(code);
        const logger = getMockLogger();
        warnAboutDivergentGlobals(ast, filePath, logger);
        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining(global), 'warn');
        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining(filePath), 'warn');
    });

    test('Should warn only once per distinct global, even if referenced multiple times', () => {
        const code =
            'export function run() { crypto.randomUUID(); crypto.randomUUID(); return crypto.randomUUID(); }';
        const ast = parseAst(code);
        const logger = getMockLogger();
        warnAboutDivergentGlobals(ast, filePath, logger);
        expect(mockLogFn).toHaveBeenCalledTimes(1);
    });

    test('Should warn for every distinct global in a multi-property destructure', () => {
        const code =
            'export function run() { const { crypto, Intl } = globalThis; return [crypto, Intl]; }';
        const ast = parseAst(code);
        const logger = getMockLogger();
        warnAboutDivergentGlobals(ast, filePath, logger);
        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('crypto'), 'warn');
        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('Intl'), 'warn');
        expect(mockLogFn).toHaveBeenCalledTimes(2);
    });

    // Regression test: a real backend entry file is transformed multiple times with the same filePath, and must still warn only once per distinct global.
    test('Should warn only once per distinct global across separate calls for the same file path', () => {
        const code = 'export function run() { return crypto.randomUUID(); }';
        const ast = parseAst(code);
        const logger = getMockLogger();

        warnAboutDivergentGlobals(ast, filePath, logger);
        warnAboutDivergentGlobals(ast, filePath, logger);
        warnAboutDivergentGlobals(ast, filePath, logger);

        expect(mockLogFn).toHaveBeenCalledTimes(1);
    });

    test('Should still warn for a different file path even after another file already warned for the same global', () => {
        const code = 'export function run() { return crypto.randomUUID(); }';
        const ast = parseAst(code);
        const logger = getMockLogger();
        const otherFilePath = '/project/src/other.backend.ts';

        warnAboutDivergentGlobals(ast, filePath, logger);
        warnAboutDivergentGlobals(ast, otherFilePath, logger);

        expect(mockLogFn).toHaveBeenCalledTimes(2);
        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining(otherFilePath), 'warn');
    });

    test('Should warn for every divergent global on a rest-destructure of globalThis, which copies every ambient global', () => {
        const code = 'export function run() { const { ...globals } = globalThis; return globals; }';
        const ast = parseAst(code);
        const logger = getMockLogger();
        warnAboutDivergentGlobals(ast, filePath, logger);
        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('crypto'), 'warn');
        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('Intl'), 'warn');
        expect(mockLogFn).toHaveBeenCalledTimes(2);
    });

    test('Should warn for every divergent global on Object.assign copying every ambient global at once', () => {
        const code =
            'export function run() { const stolen = Object.assign({}, globalThis); return stolen; }';
        const ast = parseAst(code);
        const logger = getMockLogger();
        warnAboutDivergentGlobals(ast, filePath, logger);
        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('crypto'), 'warn');
        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('Intl'), 'warn');
        expect(mockLogFn).toHaveBeenCalledTimes(2);
    });

    test('Should warn on destructuring crypto off of globalThis via a computed string-literal key', () => {
        const code = "export function run() { const { ['crypto']: c } = globalThis; return c; }";
        const ast = parseAst(code);
        const logger = getMockLogger();
        warnAboutDivergentGlobals(ast, filePath, logger);
        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('crypto'), 'warn');
    });

    const allowedCases = [
        {
            description: 'not warn on an imported action-catalog function',
            code: "import { request } from '@datadog/action-catalog/http/http';\nexport async function run() { return request({ inputs: {} }); }",
        },
        {
            description: 'not warn on a locally-declared function that happens to be named crypto',
            code: 'function crypto() { return "local"; }\nexport function run() { return crypto(); }',
        },
        {
            description: 'not warn on a parameter named Intl shadowing the global',
            code: 'export function run(Intl) { return Intl.NumberFormat; }',
        },
        {
            description: 'not warn on unrelated code with no divergent-global references',
            code: 'export function run(a, b) { return a + b; }',
        },
        {
            description: 'not warn on accessing an unrelated globalThis property',
            code: 'export function run() { return globalThis.console; }',
        },
        {
            description:
                'not warn on accessing .crypto on a parameter named globalThis shadowing the ambient global',
            code: 'export function run(globalThis) { return globalThis.crypto; }',
        },
        {
            description:
                'not warn on destructuring crypto off of a parameter named globalThis shadowing the ambient global',
            code: 'export function run(globalThis) { const { crypto } = globalThis; return crypto; }',
        },
        {
            description:
                'not warn on a nested destructure named crypto whose outer key is not itself a globalThis/global self-reference',
            code: 'export function run() { const { myApi: { crypto } } = globalThis; return crypto; }',
        },
    ];

    test.each(allowedCases)('Should $description', ({ code }) => {
        const ast = parseAst(code);
        const logger = getMockLogger();
        warnAboutDivergentGlobals(ast, filePath, logger);
        expect(mockLogFn).not.toHaveBeenCalled();
    });
});
