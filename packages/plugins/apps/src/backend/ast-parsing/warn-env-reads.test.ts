// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { analyzeModuleScope } from '@dd/apps-plugin/backend/ast-parsing/module-scope';
import { ensureProgram } from '@dd/apps-plugin/backend/ast-parsing/type-guards';
import {
    MAX_TRACKED_FILES,
    resetEnvReadWarnings,
    WHOLE_ENV_USE,
    warnAboutEnvReads,
} from '@dd/apps-plugin/backend/ast-parsing/warn-env-reads';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import { parseAst } from 'rollup/parseAst';

const FILE_PATH = '/project/src/billing.backend.ts';

function check(code: string, filePath: string = FILE_PATH): void {
    const ast = parseAst(code);
    const program = ensureProgram(ast, filePath);
    const scopeAnalysis = analyzeModuleScope(program);
    const log = getMockLogger();
    warnAboutEnvReads(ast, filePath, log, scopeAnalysis);
}

function warnings(): string[] {
    return mockLogFn.mock.calls
        .filter(([, level]) => level === 'warn')
        .map(([message]) => String(message));
}

describe('Backend Functions - warnAboutEnvReads', () => {
    beforeEach(() => {
        resetEnvReadWarnings();
    });

    const usedCases = [
        {
            description: 'process.env.X',
            code: 'export function run() { return process.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: "process.env['X']",
            code: "export function run() { return process.env['STRIPE_KEY']; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'globalThis.process.env.X',
            code: 'export function run() { return globalThis.process.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a non-ASCII identifier key',
            code: 'export function run() { return process.env.CAFÉ_KEY; }',
            uses: ['process.env.CAFÉ_KEY'],
        },
        {
            description: 'a key that is not an identifier',
            code: "export function run() { return process.env['STRIPE-KEY']; }",
            uses: ['process.env["STRIPE-KEY"]'],
        },
        {
            description: 'a key read off a parenthesized optional chain',
            code: 'export function run() { return (process?.env).STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a computed key',
            code: 'export function run(name) { return process.env[name]; }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'process.env used whole',
            code: 'export function run() { const { STRIPE_KEY } = process.env; return STRIPE_KEY; }',
            uses: [WHOLE_ENV_USE],
        },
    ];

    test.each(usedCases)('Should warn on $description', ({ code, uses }) => {
        check(code);

        const [warning, ...rest] = warnings();
        expect(rest).toEqual([]);
        const useList = uses.join(', ');
        expect(warning).toContain(`${FILE_PATH} uses ${useList}. `);
    });

    test('Should explain that v2 does not provide the values yet', () => {
        check('export function run() { return process.env.STRIPE_KEY; }');

        const logged = warnings();
        expect(logged).toEqual([
            `${FILE_PATH} uses process.env.STRIPE_KEY. The v2 backend function runtime doesn't ` +
                `pass your environment variables or Custom Credentials to backend functions yet, ` +
                `so these see your shell's values locally but not in production.`,
        ]);
    });

    const silentCases = [
        {
            description: 'a process parameter that shadows the global',
            code: 'export function run(process) { return process.env.STRIPE_KEY; }',
        },
        {
            description: 'a local const named process',
            code: 'const process = { env: {} };\nexport function run() { return process.env.STRIPE_KEY; }',
        },
        {
            description: 'a shadowed globalThis',
            code: 'export function run(globalThis) { return globalThis.process.env.STRIPE_KEY; }',
        },
        {
            description: 'NODE_ENV',
            code: "export function run() { return process.env.NODE_ENV === 'production'; }",
        },
        {
            description: 'NODE_ENV read off a parenthesized optional chain',
            code: "export function run() { return (process?.env).NODE_ENV === 'production'; }",
        },
        {
            description: 'other process properties',
            code: 'export function run() { return [process.cwd(), process.argv]; }',
        },
    ];

    test.each(silentCases)('Should not warn on $description', ({ code }) => {
        check(code);

        const logged = warnings();
        expect(logged).toEqual([]);
    });

    test('Should name every key in a file in one warning', () => {
        check(
            'export function run() { return [process.env.STRIPE_KEY, process.env.REGION, process.env.STRIPE_KEY]; }',
        );

        const [warning, ...rest] = warnings();
        expect(rest).toEqual([]);
        expect(warning).toContain('uses process.env.STRIPE_KEY, process.env.REGION. ');
    });

    test('Should not warn again about a use already reported for the same file', () => {
        const code = 'export function run() { return process.env.STRIPE_KEY; }';
        check(code);
        check(code);

        const logged = warnings();
        expect(logged).toHaveLength(1);
    });

    test('Should warn only about the uses that are new for a file', () => {
        check('export function run() { return process.env.STRIPE_KEY; }');
        check('export function run() { return [process.env.STRIPE_KEY, process.env.REGION]; }');

        const [, second] = warnings();
        expect(second).toContain('uses process.env.REGION. ');
        expect(second).not.toContain('STRIPE_KEY');
    });

    test('Should keep a reported use deduplicated however many files without uses are checked', () => {
        const code = 'export function run() { return process.env.STRIPE_KEY; }';
        check(code);
        for (let index = 0; index <= MAX_TRACKED_FILES; index++) {
            check('export function run() { return 1; }', `/project/src/pure${index}.backend.ts`);
        }
        check(code);

        const logged = warnings();
        expect(logged).toHaveLength(1);
    });

    test('Should warn about the same use in a different file', () => {
        const code = 'export function run() { return process.env.STRIPE_KEY; }';
        const otherFilePath = '/project/src/other.backend.ts';
        check(code);
        check(code, otherFilePath);

        const [, second] = warnings();
        expect(second).toContain(otherFilePath);
    });
});
