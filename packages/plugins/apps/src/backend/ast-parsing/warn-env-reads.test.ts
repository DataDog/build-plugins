// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { analyzeModuleScope } from '@dd/apps-plugin/backend/ast-parsing/module-scope';
import { rejectGlobalsMissingFromNode } from '@dd/apps-plugin/backend/ast-parsing/reject-restricted-globals';
import { ensureProgram } from '@dd/apps-plugin/backend/ast-parsing/type-guards';
import { walkAst } from '@dd/apps-plugin/backend/ast-parsing/walk-ast';
import {
    ENV_NOT_PASSED_EXPLANATION,
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
            description: 'a key read behind a truthiness guard on env',
            code: 'export function run() { if (process.env && process.env.STRIPE_KEY) { return 1; } }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a key read behind a typeof and truthiness guard',
            code: "export function run() { return typeof process !== 'undefined' && process.env && process.env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a key read behind a negated guard on env',
            code: 'export function run() { return !process.env ? undefined : process.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
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
            description: 'global.process.env.X',
            code: 'export function run() { return global.process.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process.env.X through a const alias of globalThis',
            code: 'const root = globalThis;\nexport function run() { return root.process.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a default import of node:process',
            code: "import process from 'node:process';\nexport function run() { return process.env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a namespace import of process',
            code: "import * as proc from 'process';\nexport function run() { return proc.env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env imported from node:process',
            code: "import { env } from 'node:process';\nexport function run() { return env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a compound assignment, which reads the key',
            code: "export function run() { process.env.PATH += ':/opt/bin'; }",
            uses: ['process.env.PATH'],
        },
        {
            description: 'a destructure of named keys',
            code: 'export function run() { const { STRIPE_KEY, NODE_ENV } = process.env; return [STRIPE_KEY, NODE_ENV]; }',
            uses: ['process.env.STRIPE_KEY', 'process.env.NODE_ENV'],
        },
        {
            description: 'a destructure of an env imported from node:process',
            code: "import { env } from 'node:process';\nexport function run() { const { STRIPE_KEY } = env; return STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process.env used whole',
            code: 'export function run() { const { ...all } = process.env; return all; }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'NODE_ENV',
            code: "export function run() { return process.env.NODE_ENV === 'production'; }",
            uses: ['process.env.NODE_ENV'],
        },
        {
            description: 'NODE_ENV read off a parenthesized optional chain',
            code: "export function run() { return (process?.env).NODE_ENV === 'production'; }",
            uses: ['process.env.NODE_ENV'],
        },
        {
            description: 'a destructure of only NODE_ENV',
            code: "export function run() { const { NODE_ENV } = process.env; return NODE_ENV === 'production'; }",
            uses: ['process.env.NODE_ENV'],
        },
        {
            description: 'an env imported from node:process passed whole',
            code: "import { env } from 'node:process';\nexport function run(schema) { return schema.parse(env); }",
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'an env imported from process spread into an object',
            code: "import { env } from 'process';\nexport function run() { return { ...env }; }",
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'a computed key on an env imported from node:process',
            code: "import { env } from 'node:process';\nexport function run(name) { return env[name]; }",
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'an imported env with both a static key and a whole use',
            code: "import { env } from 'node:process';\nexport function run(schema) { return [env.STRIPE_KEY, schema.parse(env)]; }",
            uses: ['process.env.STRIPE_KEY', WHOLE_ENV_USE],
        },
        {
            description: 'hasOwnProperty with a literal key',
            code: "export function run() { return process.env.hasOwnProperty('STRIPE_KEY'); }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'propertyIsEnumerable with a literal key on an imported env',
            code: "import { env } from 'node:process';\nexport function run() { return env.propertyIsEnumerable('STRIPE_KEY'); }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'hasOwnProperty called through an optional chain',
            code: "export function run() { return process.env?.hasOwnProperty('STRIPE_KEY'); }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'hasOwnProperty with a computed key',
            code: 'export function run(name) { return process.env.hasOwnProperty(name); }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'toString',
            code: 'export function run() { return process.env.toString(); }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'another Object.prototype member on an imported env',
            code: "import { env } from 'node:process';\nexport function run() { return env.constructor; }",
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'an Object.prototype member destructured from process.env',
            code: 'export function run() { const { hasOwnProperty } = process.env; return hasOwnProperty; }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'env destructured from process',
            code: 'export function run() { const { env } = process; return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env destructured from process under another name',
            code: 'const { env: vars } = globalThis.process;\nexport function run() { return vars.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env destructured from process with a default',
            code: 'const { env = {} } = process;\nexport function run() { return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env destructured from process used whole',
            code: 'const { env } = process;\nexport function run(schema) { return schema.parse(env); }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'keys destructured from an env destructured from process',
            code: 'const { env } = process;\nexport function run() { const { STRIPE_KEY } = env; return STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'keys destructured from process in one nested pattern',
            code: 'export function run() { const { env: { STRIPE_KEY } } = process; return STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a nested rest destructure of env from process',
            code: 'export function run() { const { env: { ...all } } = process; return all; }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'a const alias of process',
            code: 'const p = process;\nexport function run() { return p.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a let alias of process that is never reassigned',
            code: 'let p = process;\nexport function run() { return p.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a var alias of process that is never reassigned',
            code: 'var p = process;\nexport function run() { return p.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a var env destructured from process',
            code: 'export function run() { var { env } = process; return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'an in check with a literal key',
            code: "export function run() { return 'STRIPE_KEY' in process.env; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'an in check with a computed key',
            code: 'export function run(name) { return name in process.env; }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'Object.hasOwn with a literal key on an imported env',
            code: "import { env } from 'node:process';\nexport function run() { return Object.hasOwn(env, 'STRIPE_KEY'); }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'Object.hasOwn with a computed key',
            code: 'export function run(name) { return Object.hasOwn(process.env, name); }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'process read off a parenthesized optional chain',
            code: 'export function run() { return (globalThis?.process).env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a destructure of an optional chain',
            code: 'export function run() { const { STRIPE_KEY } = process?.env; return STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a let env destructured from a const alias of process',
            code: 'const p = process;\nlet { env } = p;\nexport function run() { return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env destructured from process in a parameter default',
            code: 'export function run({ env } = process) { return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'keys destructured from process in a parameter default',
            code: 'export function run({ env: { STRIPE_KEY } } = process) { return STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a parameter defaulting to process',
            code: 'export function run(p = process) { return p.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a parameter defaulting to process.env',
            code: 'export function run(env = process.env) { return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'an arrow parameter defaulting to process',
            code: 'export const run = (p = process) => p.env.STRIPE_KEY;',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a destructured property defaulting to process',
            code: 'export function run(options) { const { host: p = process } = options; return p.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'an array element defaulting to process',
            code: 'export function run(list) { const [p = process] = list; return p.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'keys destructured from process.env in a parameter default',
            code: 'export function run({ STRIPE_KEY } = process.env) { return STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env destructured from process in an assignment',
            code: 'export function run() { let env; ({ env } = process); return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'keys destructured from process.env in an assignment',
            code: 'export function run() { let key; ({ STRIPE_KEY: key } = process.env); return key; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env destructured from process in a for-of over an array literal',
            code: 'export function run() { for (const { env } of [process]) { return env.STRIPE_KEY; } }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env destructured from process in a for-of assigning an outer binding',
            code: 'export function run() { let env; for ({ env } of [process]) { return env.STRIPE_KEY; } }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'keys destructured from process in a for-of',
            code: 'export function run() { for (const { env: { STRIPE_KEY } } of [process]) { return STRIPE_KEY; } }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a for-of binding of process',
            code: 'export function run() { for (const p of [process]) { return p.env.STRIPE_KEY; } }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a let alias of globalThis that is never reassigned',
            code: 'let root = globalThis;\nexport function run() { return root.process.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a var alias of globalThis that is never reassigned',
            code: 'var root = globalThis;\nexport function run() { return root.process.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env read off an awaited dynamic import of node:process',
            code: "export async function run() { return (await import('node:process')).env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env destructured from an awaited dynamic import of process',
            code: "export async function run() { const { env } = await import('process'); return env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'keys destructured from an awaited dynamic import of process',
            code: "export async function run() { const { env: { STRIPE_KEY } } = await import('process'); return STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env read off an alias of a dynamic import of node:process',
            code: "export async function run() { const p = await import('node:process'); return p.env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env read off the default export of a dynamic import of node:process',
            code: "export async function run() { const p = await import('node:process'); return p.default.env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env read off the default export of an awaited dynamic import',
            code: "export async function run() { return (await import('process')).default.env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env read off the default export of a namespace import',
            code: "import * as p from 'node:process';\nexport function run() { return p.default.env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a destructure of named keys and a rest element',
            code: 'export function run() { const { STRIPE_KEY, ...rest } = process.env; return [STRIPE_KEY, rest]; }',
            uses: ['process.env.STRIPE_KEY', WHOLE_ENV_USE],
        },
        {
            description: 'a nested destructure of named keys and a rest element',
            code: 'export function run() { const { env: { STRIPE_KEY, ...rest } } = process; return [STRIPE_KEY, rest]; }',
            uses: ['process.env.STRIPE_KEY', WHOLE_ENV_USE],
        },
        {
            description: 'Object.prototype.hasOwnProperty.call with a literal key',
            code: "export function run() { return Object.prototype.hasOwnProperty.call(process.env, 'STRIPE_KEY'); }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'Object.prototype.propertyIsEnumerable.call on an imported env',
            code: "import { env } from 'node:process';\nexport function run() { return Object.prototype.propertyIsEnumerable.call(env, 'STRIPE_KEY'); }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'Object.prototype.hasOwnProperty.call with a computed key',
            code: 'export function run(name) { return Object.prototype.hasOwnProperty.call(process.env, name); }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'a for-of binding of globalThis',
            code: 'export function run() { for (const root of [globalThis]) { return root.process.env.STRIPE_KEY; } }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a const alias of process.env',
            code: 'export function run() { const env = process.env; return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a const alias of an imported env',
            code: "import { env } from 'node:process';\nconst vars = env;\nexport function run() { return vars.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a let alias of process.env that is reassigned',
            code: 'export function run() { let env = process.env; env = {}; return env.STRIPE_KEY; }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'the default export destructured from a dynamic import of process',
            code: "export async function run() { const { default: p } = await import('process'); return p.env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env nested under the default export of a dynamic import',
            code: "export async function run() { const { default: { env } } = await import('process'); return env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env destructured from process nested under globalThis',
            code: 'const { process: { env } } = globalThis;\nexport function run() { return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process destructured from globalThis',
            code: 'const { process: p } = globalThis;\nexport function run() { return p.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'Reflect.get with a literal key',
            code: "export function run() { return Reflect.get(process.env, 'STRIPE_KEY'); }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'Reflect.has with a literal key',
            code: "export function run() { return Reflect.has(process.env, 'STRIPE_KEY'); }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'Object.getOwnPropertyDescriptor with a literal key',
            code: "export function run() { return Object.getOwnPropertyDescriptor(process.env, 'STRIPE_KEY'); }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'Reflect.get with a computed key',
            code: 'export function run(name) { return Reflect.get(process.env, name); }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'a key read off the env Object.assign returns',
            code: "export function run() { const env = Object.assign(process.env, { A: '1' }); return env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a key read off env bound in a conditional statement',
            code: 'export function run(c) { let e; c ? (e = process.env) : 0; return e.FOO; }',
            uses: ['process.env.FOO'],
        },
        {
            description: 'the env Object.assign returns, passed on whole',
            code: "export function run() { return Object.assign(process.env, { TZ: 'UTC' }); }",
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'the env Object.assign returns, exported whole',
            code: "export default Object.assign(process.env, { TZ: 'UTC' });",
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'the env Object.defineProperties returns, behind a fallback',
            code: 'export function run(read) { return read(Object.defineProperties(process.env, {}) || {}); }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'the imported env Object.assign returns, spread whole',
            code: "import { env } from 'node:process';\nexport function run() { return { ...Object.assign(env, {}) }; }",
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'a key read off the env Object.defineProperty returns',
            code: "export function run() { return Object.defineProperty(process.env, 'A', { value: '1' }).STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'Object.hasOwn on env with an aliased key',
            code: "const key = 'STRIPE_KEY';\nexport function run() { return Object.hasOwn(process.env, key); }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'an in check on env with an aliased key',
            code: "const key = 'STRIPE_KEY';\nexport function run() { return key in process.env; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: "env re-exported from 'node:process'",
            code: "export { env } from 'node:process';",
            uses: [WHOLE_ENV_USE],
        },
        {
            description: "env re-exported under another name from 'process'",
            code: "export { env as settings } from 'process';",
            uses: [WHOLE_ENV_USE],
        },
        {
            description: "the default export re-exported from 'node:process'",
            code: "export { default } from 'node:process';",
            uses: [WHOLE_ENV_USE],
        },
        {
            description: "everything re-exported from 'process'",
            code: "export * from 'process';",
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'an exported alias of process.env',
            code: 'export const env = process.env;',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'an exported env destructured from process',
            code: 'export const { env } = process;',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'process behind a nullish fallback',
            code: 'export function run() { const p = globalThis.process ?? {}; return p.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env destructured from process behind an or fallback',
            code: 'export function run() { const { env } = globalThis.process || {}; return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process chosen by a conditional',
            code: 'export function run(flag) { const p = flag ? {} : process; return p.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env destructured from process beside a rest element',
            code: 'export function run() { const { env, ...rest } = process; return [env.STRIPE_KEY, rest]; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env destructured with let from process beside a rest element',
            code: 'export function run() { let { env, ...rest } = process; return [env.STRIPE_KEY, rest]; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env assigned by destructuring process beside a rest element',
            code: 'export function run() { let env, rest; ({ env, ...rest } = process); return [env.STRIPE_KEY, rest]; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env destructured from a process parameter default beside a rest element',
            code: 'export function run({ env, ...rest } = process) { return [env.STRIPE_KEY, rest]; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env passed on whole beside a rest element',
            code: 'export function run(log) { const { env, ...rest } = process; log(rest); return log(env); }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'env read off the rest of a destructure of process',
            code: 'export function run() { const { argv, ...rest } = process; return [argv, rest.env.STRIPE_KEY]; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env, but not the rest that omits it, after a destructure of process',
            code: 'export function run() { const { env, ...rest } = process; return [env.STRIPE_KEY, rest.env.REGION]; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description:
                'process.env read off the rest of a destructure of globalThis that binds env only',
            code: 'export function run() { const { env, ...rest } = globalThis; return rest.process.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env read off the rest of a destructure of process with a computed key',
            code: 'export function run(key) { const { [key]: picked, ...rest } = process; return [picked, rest.env.STRIPE_KEY]; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process read off the rest of a destructure of globalThis',
            code: 'export function run() { const { ...root } = globalThis; return root.process.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'an alias reached through more than one for-of element',
            code: 'export function run() { const p = process; for (const e of [p.argv, p.env]) { return e.STRIPE_KEY; } }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a key read off process.env behind an or fallback',
            code: 'export function run() { const env = process.env || {}; return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'keys destructured from process.env behind a nullish fallback',
            code: 'export function run() { const { STRIPE_KEY } = process.env ?? {}; return STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a key read directly off a fallback of process.env',
            code: 'export function run() { return (process.env ?? {}).STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'an in check against a fallback of process.env',
            code: "export function run() { return 'STRIPE_KEY' in (process.env || {}); }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a key read off process.env chosen by a conditional',
            code: 'export function run(flag) { const env = flag ? process.env : {}; return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a key read off the rest of a destructure of process.env',
            code: 'export function run() { const { STRIPE_KEY, ...rest } = process.env; return [STRIPE_KEY, rest.REGION]; }',
            uses: ['process.env.STRIPE_KEY', 'process.env.REGION'],
        },
        {
            description: 'env guarded by an and',
            code: 'export function run() { const env = process && process.env; return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process.env only as the guard of an and',
            code: 'export function run(config) { const vars = process.env && config; return vars.STRIPE_KEY; }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'an assignment of process.env whose value is passed on whole',
            code: 'export function run(schema) { let env; return schema.parse(env = process.env); }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'a chained assignment of process.env',
            code: 'export function run() { let a, b; a = b = process.env; return a.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'an exported binding assigned process.env after its declaration',
            code: 'export let env;\nenv = process.env;',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'a key read off an assignment of process.env',
            code: 'let env;\nexport function run() { return (env = process.env).STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'an assignment of process.env in a discarded sequence',
            code: 'let env;\nenv = process.env, 0;\nexport function run() { return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'an assignment of process.env in a for-loop initializer',
            code: 'let env;\nfor (env = process.env; false; ) {}\nexport function run() { return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'an alias read after a cyclic alias was looked up',
            code: 'var proc = alt || process;\nvar alt = proc;\nvar { env } = alt;\nconst mode = proc.mode ?? env;\nexport function run() { return [mode, env.STRIPE_KEY]; }',
            uses: [WHOLE_ENV_USE, 'process.env.STRIPE_KEY'],
        },
        {
            description: 'a key read off an assignment of process.env to a property',
            code: 'const holder = {};\nexport function run(send) { const key = (holder.env = process.env).STRIPE_KEY; return send(key, holder.env); }',
            uses: ['process.env.STRIPE_KEY', WHOLE_ENV_USE],
        },
        {
            description: 'process.env copied as an Object.assign source',
            code: 'export function run() { return Object.assign({}, process.env); }',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'process passed to a local function that reads its env',
            code: 'function read(p) { return p.env.STRIPE_KEY; } export function run() { return read(process); }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'globalThis passed to a local arrow function',
            code: 'const read = (g) => g.process.env.STRIPE_KEY; export function run() { return read(globalThis); }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process passed as a later argument',
            code: "function read(label, p) { return p.env.STRIPE_KEY; } export function run() { return read('x', process); }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process passed to a function that destructures env',
            code: 'function read({ env }) { return env.STRIPE_KEY; } export function run() { return read(process); }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process passed to a function that destructures a key',
            code: 'function read({ env: { STRIPE_KEY } }) { return STRIPE_KEY; } export function run() { return read(process); }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process passed to a parameter with a default',
            code: 'function read(p = {}) { return p.env.STRIPE_KEY; } export function run() { return read(process); }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process passed to a local constructor',
            code: 'function Settings(p) { this.key = p.env.STRIPE_KEY; } export function run() { return new Settings(process).key; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process passed to an immediately invoked arrow function',
            code: 'export function run() { return ((p) => p.env.STRIPE_KEY)(process); }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'an exported alias of process',
            code: 'export const p = process;',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'an alias of process exported by name',
            code: 'const p = process; export { p as runtimeProcess };',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: 'process as the default export',
            code: 'export default process;',
            uses: [WHOLE_ENV_USE],
        },
        {
            description: "env read in a then callback of import('process')",
            code: "export function run() { return import('process').then((p) => p.env.STRIPE_KEY); }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: "env destructured in a then callback of import('node:process')",
            code: "export function run() { return import('node:process').then(({ env }) => env.STRIPE_KEY); }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: "the default process read in a then callback of import('process')",
            code: "export function run() { return import('process').then(function (p) { return p.default.env.STRIPE_KEY; }); }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: "a variable holding the import('process') promise, awaited",
            code: "const pending = import('process'); export async function run() { const m = await pending; return m.env.STRIPE_KEY; }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: "a then callback of a variable holding the import('process') promise",
            code: "const pending = import('process'); export function run() { return pending.then((m) => m.env.STRIPE_KEY); }",
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process at the end of a comma expression',
            code: 'export function run() { return (0, process).env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process.env at the end of a comma expression',
            code: 'export function run() { return (0, process.env).STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'globalThis.process at the end of a comma expression',
            code: 'export function run() { return (0, globalThis.process).env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process spread into an object',
            code: 'export function run() { return ({ ...process }).env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'globalThis spread into an object',
            code: 'export function run() { return ({ ...globalThis }).process.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process copied as an Object.assign source',
            code: 'export function run() { return Object.assign({}, process).env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process wrapped in an object literal',
            code: 'export function run() { return ({ p: process }).p.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process wrapped in an array literal',
            code: 'export function run() { return [process][0].env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process wrapped in an object literal bound to a const',
            code: 'export function run() { const wrapped = { p: process }; return wrapped.p.env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'a key destructured through an object literal wrapping process',
            code: 'export function run() { const o = { a: process }; const { a: { env: { STRIPE_KEY } } } = o; return STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process spread over a property of the same name',
            code: 'export function run() { return ({ env: {}, ...process }).env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'env destructured from process spread over a property of the same name',
            code: 'export function run() { const { env } = { env: {}, ...process }; return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
        {
            description: 'process passed to a function declared after the call',
            code: 'export function run() { return read(process); } function read(p) { return p.env.REGION; }',
            uses: ['process.env.REGION'],
        },
        {
            description: 'env destructured from process wrapped in an object literal',
            code: 'export function run() { const { p: { env } } = { p: process }; return env.STRIPE_KEY; }',
            uses: ['process.env.STRIPE_KEY'],
        },
    ];

    test.each(usedCases)('Should warn on $description', ({ code, uses }) => {
        check(code);

        const [warning, ...rest] = warnings();
        expect(rest).toEqual([]);
        const useList = uses.join(', ');
        expect(warning).toContain(`${FILE_PATH} uses ${useList}. `);
    });

    test('Should check local functions that pass parameters to each other in a cycle quickly', () => {
        const count = 400;
        const functions = Array.from({ length: count }, (_, index) => {
            const next = (index + 1) % count;
            const later = (index + 3) % count;
            return `function g${index}(p, q) { g${next}(q, p); g${later}(p.x, q); return p.env.A; }`;
        });
        const code = `${functions.join('\n')}\nexport function run() { return g0(process, process.cwd()); }`;
        const startedAt = performance.now();

        check(code);

        const elapsedMs = performance.now() - startedAt;
        const logged = warnings();
        expect(logged).toEqual([expect.stringContaining('process.env.A')]);
        expect(elapsedMs).toBeLessThan(10_000);
    });

    test('Should check literals built from members of earlier literals quickly', () => {
        const depth = 22;
        const literals = Array.from({ length: depth }, (_, index) => {
            const previous = `o${index}`;
            return `const o${index + 1} = { p: ${previous}.p || ${previous}.q, q: ${previous}.q || ${previous}.p };`;
        });
        const code = `const o0 = { p: process.argv, q: process.argv };\n${literals.join('\n')}\nexport function run() { return o${depth}.p.STRIPE_KEY; }`;
        const startedAt = performance.now();

        check(code);

        const elapsedMs = performance.now() - startedAt;
        const logged = warnings();
        expect(logged).toEqual([]);
        expect(elapsedMs).toBeLessThan(10_000);
    });

    test('Should check object literals that refer to each other in a cycle quickly', () => {
        const depth = 24;
        const literals = Array.from({ length: depth }, (_, index) => {
            const next = `o${index + 1}`;
            return `const o${index} = { p: ${next}.p || ${next}.q, q: ${next}.q || ${next}.p };`;
        });
        const code = `${literals.join('\n')}\nconst o${depth} = { p: o0.p, q: process.argv };\nexport function run() { return o0.p.STRIPE_KEY; }`;
        const startedAt = performance.now();

        check(code);

        const elapsedMs = performance.now() - startedAt;
        const logged = warnings();
        expect(logged).toEqual([]);
        expect(elapsedMs).toBeLessThan(10_000);
    });

    test("Should explain that production doesn't pass the developer's variables", () => {
        check('export function run() { return process.env.STRIPE_KEY; }');

        const logged = warnings();
        expect(logged).toEqual([
            `${FILE_PATH} uses process.env.STRIPE_KEY. ${ENV_NOT_PASSED_EXPLANATION}`,
        ]);
        expect(ENV_NOT_PASSED_EXPLANATION).not.toMatch(/Terrapin|undefined/);
    });

    const silentCases = [
        {
            description: 'the boolean Reflect.set returns from a write into env',
            code: "export function run() { const ok = Reflect.set(process.env, 'A', '1'); return ok; }",
        },
        {
            description: 'the boolean Reflect.deleteProperty returns from env',
            code: "export function run() { const removed = Reflect.deleteProperty(process.env, 'A'); return removed; }",
        },
        {
            description: "a re-export of something other than env from 'process'",
            code: "export { cwd } from 'process';",
        },
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
            description: 'an assignment to a key',
            code: "process.env.TZ = 'UTC';\nexport function run() { return new Date().toString(); }",
        },
        {
            description: 'an assignment to process.env itself',
            code: "process.env = { TZ: 'UTC' };\nexport function run() { return 1; }",
        },
        {
            description: 'a deleted key',
            code: 'export function run() { delete process.env.STRIPE_KEY; }',
        },
        {
            description: 'a write to a computed key',
            code: 'export function run(name, value) { process.env[name] = value; }',
        },
        {
            description: 'a deleted computed key',
            code: 'export function run(name) { delete process.env[name]; }',
        },
        {
            description: 'a key deleted through an optional chain',
            code: 'export function run() { delete process.env?.STRIPE_KEY; }',
        },
        {
            description: 'a process imported from another module',
            code: "import process from './process';\nexport function run() { return process.env.STRIPE_KEY; }",
        },
        {
            description: 'env imported from another module',
            code: "import { env } from './config';\nexport function run() { return env.STRIPE_KEY; }",
        },
        {
            description: 'other process properties',
            code: 'export function run() { return [process.cwd(), process.argv]; }',
        },
        {
            description: 'a write to a key of an imported env',
            code: "import { env } from 'node:process';\nenv.TZ = 'UTC';\nexport function run() { return 1; }",
        },
        {
            description: 'a write to a computed key of an imported env',
            code: "import { env } from 'node:process';\nexport function run(name, value) { env[name] = value; }",
        },
        {
            description: 'a deleted computed key of an imported env',
            code: "import { env } from 'node:process';\nexport function run(name) { delete env[name]; }",
        },
        {
            description: 'an env destructured from a local object',
            code: 'const config = { env: {} };\nconst { env } = config;\nexport function run() { return env.STRIPE_KEY; }',
        },
        {
            description: 'a let alias of process that is reassigned',
            code: 'let p = process;\np = { env: {} };\nexport function run() { return p.env.STRIPE_KEY; }',
        },
        {
            description: 'a var alias of process that is reassigned',
            code: 'var p = process;\np = { env: {} };\nexport function run() { return p.env.STRIPE_KEY; }',
        },
        {
            description: 'a var alias of process that is redeclared',
            code: 'var p = process;\nvar p = { env: {} };\nexport function run() { return p.env.STRIPE_KEY; }',
        },
        {
            description: 'Object.hasOwn on a shadowed Object with another receiver',
            code: "const Object = { hasOwn: () => true };\nexport function run(config) { return Object.hasOwn(config, 'STRIPE_KEY'); }",
        },
        {
            description: 'a const alias of a local object',
            code: 'const p = { env: {} };\nexport function run() { return p.env.STRIPE_KEY; }',
        },
        {
            description: 'an env destructured in an assignment and then reassigned',
            code: 'export function run() { let env; ({ env } = process); env = {}; return env.STRIPE_KEY; }',
        },
        {
            description: 'a parameter defaulting to process that is reassigned',
            code: 'export function run(p = process) { p = { env: {} }; return p.env.STRIPE_KEY; }',
        },
        {
            description: 'a parameter defaulting to a local object',
            code: 'const local = { env: {} };\nexport function run(p = local) { return p.env.STRIPE_KEY; }',
        },
        {
            description: 'a parameter default env that is reassigned',
            code: 'export function run({ env } = process) { env = {}; return env.STRIPE_KEY; }',
        },
        {
            description: 'a let for-of env that is reassigned',
            code: 'export function run() { for (let { env } of [process]) { env = {}; return env.STRIPE_KEY; } }',
        },
        {
            description: 'a for-of over something other than an array literal',
            code: 'export function run(list) { for (const { env } of list) { return env.STRIPE_KEY; } }',
        },
        {
            description: 'a let alias of globalThis that is reassigned',
            code: 'let root = globalThis;\nroot = { process: { env: {} } };\nexport function run() { return root.process.env.STRIPE_KEY; }',
        },
        {
            description: 'a dynamic import of another module',
            code: "export async function run() { return (await import('./process')).env.STRIPE_KEY; }",
        },
        {
            description: 'default read off a default import of node:process',
            code: "import p from 'node:process';\nexport function run() { return p.default.env.STRIPE_KEY; }",
        },
        {
            description: 'a const alias of process.env that is only written',
            code: "export function run() { const env = process.env; env.TZ = 'UTC'; }",
        },
        {
            description: 'a key of process.env as a destructuring assignment target',
            code: 'export function run(config) { ({ key: process.env.STRIPE_KEY } = config); }',
        },
        {
            description: 'a key of process.env as a defaulted destructuring assignment target',
            code: "export function run(config) { ({ key: process.env.STRIPE_KEY = 'none' } = config); }",
        },
        {
            description: 'a key of process.env as an array destructuring assignment target',
            code: 'export function run(values) { [process.env.STRIPE_KEY] = values; }',
        },
        {
            description: 'a key of process.env as a for-of target',
            code: 'export function run(values) { for (process.env.STRIPE_KEY of values) {} }',
        },
        {
            description: 'Reflect.set on process.env',
            code: "export function run() { Reflect.set(process.env, 'TZ', 'UTC'); }",
        },
        {
            description: 'Reflect.deleteProperty on process.env',
            code: "export function run() { Reflect.deleteProperty(process.env, 'TZ'); }",
        },
        {
            description: 'Reflect.defineProperty on process.env',
            code: "export function run() { Reflect.defineProperty(process.env, 'TZ', { value: 'UTC' }); }",
        },
        {
            description: 'Object.assign writing into process.env',
            code: "export function run() { Object.assign(process.env, { TZ: 'UTC' }); }",
        },
        {
            description: 'the boolean Reflect.defineProperty returns for process.env',
            code: "export function run() { return Reflect.defineProperty(process.env, 'TZ', { value: 'UTC' }); }",
        },
        {
            description: 'an optional Object.assign call into process.env',
            code: "export function run() { Object.assign?.(process.env, { TZ: 'UTC' }); }",
        },
        {
            description: 'Object.assign into process.env behind a guard',
            code: "export function run(c) { c && Object.assign(process.env, { TZ: 'UTC' }); }",
        },
        {
            description: 'Object.assign into process.env behind void or await',
            code: 'export async function run() { void Object.assign(process.env, {}); await Object.assign(process.env, {}); }',
        },
        {
            description: 'Object.assign into process.env in a conditional statement',
            code: 'export function run(c) { c ? Object.assign(process.env, {}) : 0; }',
        },
        {
            description: 'Object.assign into process.env in a non-final comma operand',
            code: 'export function run() { const x = (Object.assign(process.env, {}), 1); return x; }',
        },
        {
            description: 'Object.assign into process.env in a discarded sequence',
            code: "export function run() { Object.assign(process.env, { TZ: 'UTC' }), Object.assign(process.env, {}); }",
        },
        {
            description: 'Object.defineProperty on process.env',
            code: "export function run() { Object.defineProperty(process.env, 'TZ', { value: 'UTC' }); }",
        },
        {
            description: 'Object.defineProperties on an imported env',
            code: "import { env } from 'node:process';\nexport function run() { Object.defineProperties(env, { TZ: { value: 'UTC' } }); }",
        },
        {
            description: 'the rest of a destructure of process that also binds env',
            code: 'export function run(log) { const { env, ...rest } = process; return log(rest); }',
        },
        {
            description: 'the rest of a process parameter default that also binds env',
            code: 'export function run(log, { env, ...rest } = process) { return log(rest); }',
        },
        {
            description: 'env read off the rest of a destructure of process that binds env',
            code: 'export function run() { const { env, ...rest } = process; return rest.env.STRIPE_KEY; }',
        },
        {
            description: 'env read off the rest of a let destructure of process that binds env',
            code: 'export function run() { let { env, ...rest } = process; return rest.env.STRIPE_KEY; }',
        },
        {
            description: 'env read off the rest of a process parameter default that binds env',
            code: 'export function run({ env, ...rest } = process) { return rest.env.STRIPE_KEY; }',
        },
        {
            description:
                'env read off the rest of an assignment destructuring process that binds env',
            code: 'export function run() { let env, rest; ({ env, ...rest } = process); return rest.env.STRIPE_KEY; }',
        },
        {
            description: 'env read off the rest of a destructure of process that renames env',
            code: 'export function run() { const { env: vars, ...rest } = process; return rest.env.STRIPE_KEY; }',
        },
        {
            description:
                'env read off the rest of a destructure of the process namespace that binds env',
            code: "import * as proc from 'process';\nexport function run() { const { env, ...rest } = proc; return rest.env.STRIPE_KEY; }",
        },
        {
            description:
                'env read off the rest of a destructure of a dynamic process import that binds env',
            code: "export async function run() { const { env, ...rest } = await import('node:process'); return rest.env.STRIPE_KEY; }",
        },
        {
            description:
                'process read off the rest of a destructure of globalThis that binds process',
            code: 'export function run() { const { process: p, ...rest } = globalThis; return rest.process.env.STRIPE_KEY; }',
        },
        {
            description: 'env read off the rest of a nested destructure of process that binds env',
            code: 'export function run() { const { process: { env, ...rest } } = globalThis; return rest.env.STRIPE_KEY; }',
        },
        {
            description: 'a local function that reads env off an argument other than process',
            code: 'function read(p) { return p.env.STRIPE_KEY; } export function run() { return read({ env: {} }); }',
        },
        {
            description: 'process passed to a local function in a position it does not read',
            code: 'function read(label, p) { return label.env.STRIPE_KEY; } export function run() { return read({ env: {} }, process); }',
        },
        {
            description: "a then callback of an import of a module other than 'process'",
            code: "export function run() { return import('./settings').then((p) => p.env.STRIPE_KEY); }",
        },
        {
            description: 'something other than process at the end of a comma expression',
            code: 'export function run() { const other = { env: {} }; return (process, other).env.STRIPE_KEY; }',
        },
        {
            description: 'a member of an object literal other than the one wrapping process',
            code: 'export function run() { return ({ p: process, q: { env: {} } }).q.env.STRIPE_KEY; }',
        },
        {
            description: 'a literal member that refers back to itself',
            code: 'export function run() { const a = { p: a.p, q: process }; return a.p.env.STRIPE_KEY; }',
        },
        {
            description: 'an exported alias of the global object',
            code: "export const root = typeof window !== 'undefined' ? window : globalThis; export default globalThis;",
        },
        {
            description: 'a property written after process is spread over it',
            code: 'export function run() { return ({ ...process, env: {} }).env.STRIPE_KEY; }',
        },
        {
            description: 'a callback a local function calls with process, declared after the call',
            code: 'export function run() { return apply((p) => p.env.STRIPE_KEY); } function apply(fn) { return fn(process); }',
        },
        {
            description: 'a callback a local function calls with process, declared before the call',
            code: 'function apply(fn) { return fn(process); } export function run() { return apply((p) => p.env.STRIPE_KEY); }',
        },
        {
            description: 'an exported alias of something other than process',
            code: 'const p = { env: {} }; export { p }; export default p;',
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

    test('Should report the same uses whether or not the ambient-global walk ran first', () => {
        const code =
            'export function run() { for (const root of [globalThis]) { return root.process.env.STRIPE_KEY; } }';
        check(code);
        const alone = warnings();
        resetEnvReadWarnings();
        mockLogFn.mockClear();

        const ast = parseAst(code);
        const program = ensureProgram(ast, FILE_PATH);
        const scopeAnalysis = analyzeModuleScope(program);
        const log = getMockLogger();
        rejectGlobalsMissingFromNode(ast, FILE_PATH, scopeAnalysis);
        warnAboutEnvReads(ast, FILE_PATH, log, scopeAnalysis);

        const afterWalk = warnings();
        expect(alone).toEqual([expect.stringContaining('uses process.env.STRIPE_KEY. ')]);
        expect(afterWalk).toEqual(alone);
    });

    test("Should follow Rollup's call-expression form of a dynamic import", () => {
        const code =
            "export async function run() { const { env } = await import('process'); return env.STRIPE_KEY; }";
        const ast = parseAst(code);
        const program = ensureProgram(ast, FILE_PATH);
        const scopeAnalysis = analyzeModuleScope(program);
        walkAst(program, null, {
            ImportExpression(node) {
                const callee = { type: 'Import' };
                const callForm = { type: 'CallExpression', callee, arguments: [node.source] };
                Object.assign(node, callForm);
            },
        });
        const log = getMockLogger();
        warnAboutEnvReads(ast, FILE_PATH, log, scopeAnalysis);

        const logged = warnings();
        expect(logged).toEqual([expect.stringContaining('uses process.env.STRIPE_KEY. ')]);
    });

    test('Should resolve a long chain of fallback aliases without re-resolving each branch', () => {
        const depth = 40;
        const aliases = Array.from(
            { length: depth },
            (_, index) => `const a${index + 1} = a${index} ?? a${index};`,
        );
        const code = `const a0 = {};\n${aliases.join('\n')}\nexport function run() { return [a${depth}.env, process.cwd()]; }`;

        check(code);

        const logged = warnings();
        expect(logged).toEqual([]);
    });

    test('Should resolve aliases that refer back to each other without re-resolving each cycle', () => {
        const depth = 40;
        const aliases = Array.from(
            { length: depth },
            (_, index) => `var a${index} = a${index + 1} || a${index + 2};`,
        );
        const code = `${aliases.join('\n')}\nvar a${depth} = a0;\nexport function run() { return [a${depth}.env, process.cwd()]; }`;

        check(code);

        const logged = warnings();
        expect(logged).toEqual([]);
    });

    test('Should warn only once per file when an alias chain is too deep to follow', () => {
        const depth = 5000;
        const aliases = Array.from(
            { length: depth },
            (_, index) => `var a${index} = a${index + 1};`,
        );
        const code = `${aliases.join('\n')}\nvar a${depth} = process;\nexport function run() { return a0.env.STRIPE_KEY; }`;

        check(code);
        check(code);

        const logged = warnings();
        expect(logged).toHaveLength(1);
    });

    test('Should warn instead of failing when an alias chain passed to a local function is too deep to follow', () => {
        const depth = 5000;
        const aliases = Array.from(
            { length: depth },
            (_, index) => `var a${index} = a${index + 1};`,
        );
        const code = `${aliases.join('\n')}\nvar a${depth} = 1;\nfunction read(p) { return p; }\nexport function run() { return read(a0) + global.x; }`;

        const run = () => check(code);

        expect(run).not.toThrow();
        const logged = warnings();
        expect(logged).toEqual([
            expect.stringContaining(`Could not check ${FILE_PATH} for process.env reads`),
        ]);
    });

    test('Should warn instead of failing when an alias chain is too deep to follow', () => {
        const depth = 5000;
        const aliases = Array.from(
            { length: depth },
            (_, index) => `var a${index} = a${index + 1};`,
        );
        const code = `${aliases.join('\n')}\nvar a${depth} = process;\nexport function run() { return a0.env.STRIPE_KEY; }`;

        const run = () => check(code);

        expect(run).not.toThrow();
        const logged = warnings();
        expect(logged).toEqual([
            expect.stringContaining(`Could not check ${FILE_PATH} for process.env reads`),
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
});
