// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as ambientGlobalAccess from '@dd/apps-plugin/backend/ast-parsing/ambient-global-access';
import { analyzeModuleScope } from '@dd/apps-plugin/backend/ast-parsing/module-scope';
import { ensureProgram } from '@dd/apps-plugin/backend/ast-parsing/type-guards';
import {
    ENV_NOT_PASSED_EXPLANATION,
    MAX_TRACKED_FILES,
    type WarnedEnvReads,
    WHOLE_ENV_USE,
    warnAboutEnvReads,
} from '@dd/apps-plugin/backend/ast-parsing/warn-env-reads';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import { parseAst } from 'rollup/parseAst';

const FILE_PATH = '/project/src/billing.backend.ts';
let warnedEnvReads: WarnedEnvReads;

function check(code: string, filePath: string = FILE_PATH): void {
    const ast = parseAst(code);
    const program = ensureProgram(ast, filePath);
    const scopeAnalysis = analyzeModuleScope(program);
    const log = getMockLogger();
    warnAboutEnvReads(ast, filePath, log, scopeAnalysis, warnedEnvReads);
}

function warnings(): string[] {
    return mockLogFn.mock.calls
        .filter(([, level]) => level === 'warn')
        .map(([message]) => String(message));
}

describe('Backend Functions - warnAboutEnvReads', () => {
    beforeEach(() => {
        warnedEnvReads = new Map();
    });

    const mustWarn = [
        {
            form: 'process.env.X',
            code: 'export function run() { return process.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: "process.env['X']",
            code: "export function run() { return process.env['STRIPE_KEY']; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'a key that is not an identifier',
            code: "export function run() { return process.env['STRIPE-KEY']; }",
            uses: ['process.env["STRIPE-KEY"]'],
        },
        {
            form: 'a non-ASCII identifier key',
            code: 'export function run() { return process.env.CAFÉ_KEY; }',
            uses: ['process.env.CAFÉ_KEY'],
        },
        {
            form: 'a dynamic key',
            code: 'export function run(name) { return process.env[name]; }',
            uses: [WHOLE_ENV_USE],
        },
        {
            form: 'an optional read',
            code: 'export function run() { return process.env?.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'a key read behind a guard on env',
            code: 'export function run() { if (process.env && process.env.STRIPE_KEY) { return 1; } }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'a destructure from process.env, with a rename and a default',
            code: "export function run() { const { STRIPE_KEY, REGION: region = 'us' } = process.env; return [STRIPE_KEY, region]; }",
            uses: ['process.env.STRIPE_KEY', 'process.env.REGION'],
        },
        {
            form: 'a destructuring assignment from process.env',
            code: 'let key; export function run() { ({ STRIPE_KEY: key } = process.env); return key; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'a rest destructure from process.env',
            code: 'export function run() { const { ...all } = process.env; return all; }',
            uses: [WHOLE_ENV_USE],
        },
        {
            form: "an env import from 'node:process'",
            code: "import { env } from 'node:process';\nexport function run() { return env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: "a renamed env import from 'process'",
            code: "import { env as vars } from 'process';\nexport function run() { const { REGION } = vars; return [REGION, vars.STRIPE_KEY]; }",
            uses: ['process.env.REGION', 'process.env.STRIPE_KEY'],
        },
        {
            form: "a default process import from 'node:process'",
            code: "import proc from 'node:process';\nexport function run() { return proc.env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: "a namespace import from 'node:process'",
            code: "import * as proc from 'node:process';\nexport function run() { return proc.env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: "a default import by name from 'process'",
            code: "import { default as proc } from 'process';\nexport function run() { return proc.env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'a nested destructure of env from process',
            code: 'export function run() { const { env: { STRIPE_KEY } } = process; return STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'a nested destructuring assignment of env from process, with a default',
            code: 'let key; export function run() { ({ env: { STRIPE_KEY: key } = {} } = process); return key; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'a destructured parameter defaulting to process.env',
            code: 'export function run({ STRIPE_KEY } = process.env) { return STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'a destructure from process.env with a fallback',
            code: 'export function run() { const { STRIPE_KEY } = process.env ?? {}; return STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'a const alias of process.env with a fallback',
            code: 'const env = process.env || {};\nexport function run() { return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'a const alias of process.env',
            code: 'const env = process.env;\nexport function run() { return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'env destructured from process',
            code: 'const { env } = process;\nexport function run() { return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'a logical assignment, which reads the value first',
            code: "export function run() { process.env.STRIPE_KEY ??= 'x'; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'env destructured from process with a default',
            code: 'const { env = {} } = process;\nexport function run() { return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'env destructured from process under another name',
            code: 'export function run() { const { env: vars } = process; return vars.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'a destructure from an optional process?.env',
            code: 'export function run() { const { STRIPE_KEY } = process?.env; return STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'a const alias of an optional process?.env',
            code: 'const env = process?.env;\nexport function run() { return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'a computed key read inside a destructuring write',
            code: 'export function run(o) { ({ [process.env.STRIPE_KEY]: process.env.REGION } = o); }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            form: 'a read of a key named like an Object.prototype member',
            code: 'export function run() { return process.env.constructor; }',
            uses: ['process.env.constructor'],
        },
        {
            form: 'a destructure of a key named like an Object.prototype member',
            code: 'export function run() { const { toString } = process.env; return toString; }',
            uses: ['process.env.toString'],
        },
    ];

    test.each(mustWarn)('Should warn on $form', ({ code, uses }) => {
        check(code);

        const logged = warnings();
        const useList = uses.join(', ');
        expect(logged).toEqual([`${FILE_PATH} uses ${useList}. ${ENV_NOT_PASSED_EXPLANATION}`]);
    });

    const mustNotWarn = [
        {
            form: 'a write to process.env',
            code: "export function run() { process.env.STRIPE_KEY = 'x'; }",
        },
        {
            form: 'a delete from process.env',
            code: 'export function run() { delete process.env.STRIPE_KEY; }',
        },
        {
            form: 'an optional delete from process.env',
            code: 'export function run() { delete process.env?.STRIPE_KEY; }',
        },
        {
            form: 'an optional computed delete from process.env',
            code: "export function run() { delete process.env?.['STRIPE_KEY']; }",
        },
        {
            form: 'an optional delete through a const alias of process.env',
            code: 'const env = process.env;\nexport function run() { delete env?.STRIPE_KEY; }',
        },
        {
            form: 'an array destructuring write to process.env',
            code: 'export function run(parts) { [process.env.REGION, ...process.env.REST] = parts; }',
        },
        {
            form: 'an object destructuring write to process.env, with a default',
            code: "export function run(o) { ({ a: process.env.REGION = 'us', ...process.env.REST } = o); }",
        },
        {
            form: 'a nested destructuring write to process.env',
            code: 'export function run(o) { ({ a: [process.env.REGION] } = o); }',
        },
        {
            form: 'a for...of write to process.env',
            code: 'export function run(xs) { for (process.env.REGION of xs) {} }',
        },
        {
            form: 'a for...in write to process.env',
            code: 'export function run(o) { for (process.env.REGION in o) {} }',
        },
        {
            form: 'a for...of destructuring write to process.env',
            code: 'export function run(xs) { for ([process.env.REGION] of xs) {} }',
        },
        {
            form: 'a call of an inherited Object.prototype method',
            code: "export function run() { return process.env.hasOwnProperty('STRIPE_KEY'); }",
        },
        {
            form: 'an optional call of an inherited Object.prototype method',
            code: "export function run() { return [process.env?.hasOwnProperty('STRIPE_KEY'), process.env.toString?.()]; }",
        },
        {
            form: 'a process parameter that shadows the global',
            code: 'export function run(process) { return process.env.STRIPE_KEY; }',
        },
        {
            form: 'a local const named process',
            code: 'const process = { env: {} };\nexport function run() { return process.env.STRIPE_KEY; }',
        },
        {
            form: 'an env import from another module',
            code: "import { env } from './config';\nexport function run() { return env.STRIPE_KEY; }",
        },
        {
            form: 'a destructure from the right side of process.env &&',
            code: 'export function run(o) { const { STRIPE_KEY } = process.env && o; return STRIPE_KEY; }',
        },
        {
            form: 'a destructured parameter defaulting to another object',
            code: 'export function run({ STRIPE_KEY } = { STRIPE_KEY: process.argv[2] }) { return STRIPE_KEY; }',
        },
        {
            form: 'a process member other than env',
            code: 'export function run() { return [process.cwd(), process.argv[0]]; }',
        },
        {
            form: 'a let alias of process.env, not followed',
            code: 'let env = process.env;\nexport function run() { return env.STRIPE_KEY; }',
        },
        {
            form: 'a second-level alias, not followed',
            code: 'const env = process.env;\nconst vars = env;\nexport function run() { return vars.STRIPE_KEY; }',
        },
        {
            form: 'process.env passed on as a whole, not followed',
            code: 'export function run(read) { return read(process.env); }',
        },
    ];

    test.each(mustNotWarn)('Should not warn on $form', ({ code }) => {
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

    test('Should warn once per file, without failing, when the check itself throws', () => {
        const staticMemberName = jest
            .spyOn(ambientGlobalAccess, 'staticMemberName')
            .mockImplementation(() => {
                throw new Error('unexpected node');
            });
        try {
            const code = 'export function run() { return process.env.STRIPE_KEY; }';
            check(code);
            check(code);
        } finally {
            staticMemberName.mockRestore();
        }

        const logged = warnings();
        expect(logged).toEqual([
            `Could not check ${FILE_PATH} for process.env reads: unexpected node`,
        ]);
    });

    test('Should warn about the same use in a different file', () => {
        const code = 'export function run() { return process.env.STRIPE_KEY; }';
        const otherFilePath = '/project/src/other.backend.ts';
        check(code);
        check(code, otherFilePath);

        const [, second] = warnings();
        expect(second).toContain(otherFilePath);
    });

    test('Should warn again about a use once more files with uses than the cap were checked', () => {
        const code = 'export function run() { return process.env.STRIPE_KEY; }';
        check(code);
        for (let index = 0; index < MAX_TRACKED_FILES; index++) {
            check(code, `/project/src/reader${index}.backend.ts`);
        }
        check(code);

        const logged = warnings();
        const firstFileWarnings = logged.filter((warning) => warning.startsWith(`${FILE_PATH} `));
        expect(firstFileWarnings).toHaveLength(2);
    });
});
