// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { ESLint } from 'eslint';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const TEST_FILE_PATH = path.join(REPO_ROOT, 'packages/plugins/example/src/example.test.ts');

const eslint = new ESLint({ cwd: REPO_ROOT });

const countProcessEnvViolations = async (code: string, filePath: string) => {
    const [result] = await eslint.lintText(code, { filePath });
    if (result.fatalErrorCount) {
        throw new Error(`Snippet failed to parse: ${code}`);
    }
    const violations = result.messages.filter(
        (message) => message.ruleId === '@dd/no-whole-process-env' && message.severity === 2,
    );
    return violations.length;
};

describe('process.env lint rule for tests', () => {
    const cases = [
        {
            description: 'flag reassigning it',
            code: "process.env = { PATH: '/bin' };",
            expected: 1,
        },
        {
            description: 'flag replacing it with jest.replaceProperty',
            code: "jest.replaceProperty(process, 'env', {});",
            expected: 1,
        },
        {
            description: 'flag replacing it with Object.defineProperty',
            code: "Object.defineProperty(process, 'env', { value: {} });",
            expected: 1,
        },
        {
            description: 'flag reaching it with bracket access',
            code: "const env = process['env'];",
            expected: 1,
        },
        { description: 'flag aliasing it', code: 'const env = process.env;', expected: 1 },
        { description: 'flag spreading it', code: 'const copy = { ...process.env };', expected: 1 },
        {
            description: 'flag a rest destructure of it',
            code: 'const { PATH, ...rest } = process.env;',
            expected: 1,
        },
        {
            description: 'flag passing it to a function',
            code: 'const copy = Object.assign({}, process.env);',
            expected: 1,
        },
        {
            description: 'flag asserting on it whole',
            code: 'expect(process.env).toEqual({});',
            expected: 1,
        },
        {
            description: 'flag handing it to a child process',
            code: "spawn('node', [], { env: process.env });",
            expected: 1,
        },
        {
            description: 'flag destructuring it off process',
            code: 'const { env } = process;',
            expected: 1,
        },
        {
            description: 'flag assignment-destructuring it off process',
            code: 'let env;\n({ env } = process);',
            expected: 1,
        },
        {
            description: 'flag destructuring it off process with a computed key',
            code: "const { ['env']: env } = process;",
            expected: 1,
        },
        {
            description: 'flag a nested rest destructure of it off process',
            code: 'const { env: { ...rest } } = process;',
            expected: 1,
        },
        {
            description: 'flag reaching it with a template-literal key',
            code: 'const env = process[`env`];',
            expected: 1,
        },
        {
            description: 'flag destructuring it off process with a template-literal key',
            code: 'const { [`env`]: env } = process;',
            expected: 1,
        },
        {
            description: 'flag replacing it with a template-literal key',
            code: 'jest.replaceProperty(process, `env`, {});',
            expected: 1,
        },
        {
            description: 'flag reading it with Reflect.get',
            code: "const env = Reflect.get(process, 'env');",
            expected: 1,
        },
        {
            description: 'flag destructuring it off process with a default',
            code: 'const { env = {} } = process;',
            expected: 1,
        },
        {
            description: 'flag a defaulted nested rest destructure of it off process',
            code: 'const { env: { ...rest } = {} } = process;',
            expected: 1,
        },
        {
            description: 'allow reading one key through a template-literal key',
            code: 'const path = process[`env`].PATH;',
            expected: 0,
        },
        {
            description: 'allow checking that process has it with Object.hasOwn',
            code: "const hasEnv = Object.hasOwn(process, 'env');",
            expected: 0,
        },
        {
            description: 'allow checking that process has it with Reflect.has',
            code: "const hasEnv = Reflect.has(process, 'env');",
            expected: 0,
        },
        {
            description: 'allow defaulted nested destructuring of named keys off process',
            code: 'const { env: { PATH } = {} } = process;',
            expected: 0,
        },
        {
            description:
                'allow defaulted nested assignment-destructuring of named keys off process',
            code: 'let PATH;\n({ env: { PATH } = {} } = process);',
            expected: 0,
        },
        {
            description: 'allow nested destructuring of named keys off process',
            code: 'const { env: { PATH } } = process;',
            expected: 0,
        },
        {
            description: 'allow nested assignment-destructuring of named keys off process',
            code: 'let PATH;\n({ env: { PATH } } = process);',
            expected: 0,
        },
        {
            description: 'allow setting one key',
            code: "process.env.DD_SITE = 'datadoghq.com';",
            expected: 0,
        },
        { description: 'allow deleting one key', code: 'delete process.env.DD_SITE;', expected: 0 },
        {
            description: 'allow reading one key',
            code: 'const site = process.env.DD_SITE;',
            expected: 0,
        },
        {
            description: 'allow a computed key',
            code: "const key = 'DD_SITE';\nprocess.env[key] = 'datadoghq.com';",
            expected: 0,
        },
        {
            description: 'allow destructuring named keys',
            code: 'const { NEED_BUILD, REQUESTED_BUNDLERS } = process.env;',
            expected: 0,
        },
        {
            description: 'allow assignment-destructuring named keys',
            code: 'let PATH;\n({ PATH } = process.env);',
            expected: 0,
        },
        {
            description: 'flag a rest assignment-destructure of it',
            code: 'let rest;\n({ ...rest } = process.env);',
            expected: 1,
        },
        {
            description: 'flag importing it from process',
            code: "import { env } from 'process';",
            expected: 1,
        },
        {
            description: 'flag importing it from node:process',
            code: "import { env } from 'node:process';",
            expected: 1,
        },
        {
            description: 'flag requiring it from process',
            code: "const env = require('process').env;",
            expected: 1,
        },
        {
            description: 'flag destructuring it from a required process',
            code: "const { env } = require('node:process');",
            expected: 1,
        },
        {
            description: 'flag reaching it with optional chaining',
            code: 'const env = process?.env;',
            expected: 1,
        },
        {
            description: 'flag serializing it',
            code: 'const text = JSON.stringify(process.env);',
            expected: 1,
        },
        {
            description: 'flag using an assignment-destructure of it as a value',
            code: 'let A;\nconst copy = ({ A } = process.env);',
            expected: 1,
        },
        {
            description: 'allow a computed process key held in a variable named env',
            code: "const env = 'DD_SITE';\nconst value = process[env];",
            expected: 0,
        },
        {
            description: 'allow destructuring a process key held in a variable named env',
            code: "const env = 'DD_SITE';\nconst { [env]: value } = process;",
            expected: 0,
        },
        {
            description: 'allow a keyed call on process with a variable named env',
            code: "const env = 'DD_SITE';\nconst value = Reflect.get(process, env);",
            expected: 0,
        },
        {
            description: 'flag reaching it through a type assertion',
            code: 'const env = (process as typeof process).env;',
            expected: 1,
        },
        {
            description: 'flag reaching it through a non-null assertion',
            code: 'const env = process!.env;',
            expected: 1,
        },
        {
            description: 'flag reaching it through a comma expression',
            code: 'const env = (0, process).env;',
            expected: 1,
        },
        {
            description: 'flag reaching it through an alias of process',
            code: 'const nodeProcess = process;\nconst env = nodeProcess.env;',
            expected: 1,
        },
        {
            description: 'flag reaching it through globalThis',
            code: 'const env = globalThis.process.env;',
            expected: 1,
        },
        {
            description: 'flag reaching it through global',
            code: 'const env = global.process.env;',
            expected: 1,
        },
        {
            description: 'flag copying it with valueOf',
            code: 'const env = process.env.valueOf();',
            expected: 1,
        },
        {
            description: 'flag reaching it through a namespace import',
            code: "import * as nodeProcess from 'node:process';\nconst env = nodeProcess.env;",
            expected: 1,
        },
        {
            description: 'flag importing it under another name',
            code: "import { env as runtimeEnv } from 'process';",
            expected: 1,
        },
        {
            description: 'flag re-exporting it',
            code: "export { env } from 'node:process';",
            expected: 1,
        },
        {
            description: 'flag destructuring it from a dynamic import',
            code: "const { env } = await import('process');",
            expected: 1,
        },
        {
            description: 'flag reaching it on a dynamic import',
            code: "const env = (await import('node:process')).env;",
            expected: 1,
        },
        {
            description: 'flag requiring it with a template-literal specifier',
            code: 'const env = require(`process`).env;',
            expected: 1,
        },
        {
            description: 'flag destructuring it off process in a parameter default',
            code: 'const getEnv = ({ env } = process) => env;',
            expected: 1,
        },
        {
            description: 'allow checking that process has it with hasOwnProperty.call',
            code: "const hasEnv = Object.prototype.hasOwnProperty.call(process, 'env');",
            expected: 0,
        },
        {
            description: 'allow checking for a key with hasOwnProperty.call',
            code: "const hasSite = Object.prototype.hasOwnProperty.call(process.env, 'DD_SITE');",
            expected: 0,
        },
        {
            description: 'flag passing it to a hasOwnProperty.call on another object',
            code: "const o = { hasOwnProperty: { call: (value) => value } };\nconst copy = o.hasOwnProperty.call(process.env, 'A');",
            expected: 1,
        },
        {
            description: 'flag passing it to hasOwnProperty.call on a shadowed Object',
            code: "const Object = { prototype: { hasOwnProperty: { call: (value) => value } } };\nconst copy = Object.prototype.hasOwnProperty.call(process.env, 'A');",
            expected: 1,
        },
        {
            description: 'allow listing its names with getOwnPropertyNames',
            code: 'const names = Object.getOwnPropertyNames(process.env);',
            expected: 0,
        },
        {
            description: 'allow listing its names with Reflect.ownKeys',
            code: 'const names = Reflect.ownKeys(process.env);',
            expected: 0,
        },
        {
            description: 'allow listing its names through optional chaining',
            code: 'const names = Object.keys(process?.env);',
            expected: 0,
        },
        {
            description: 'allow destructuring named keys through a type assertion',
            code: 'const { DD_SITE } = process.env as Record<string, string>;',
            expected: 0,
        },
        {
            description: 'allow assignment-destructuring named keys in a comma expression',
            code: 'let PATH;\nlet count;\n(count = 1, { PATH } = process.env);',
            expected: 0,
        },
        {
            description: 'allow destructuring named keys in a parameter default',
            code: 'const getPath = ({ PATH } = process.env) => PATH;',
            expected: 0,
        },
        {
            description: 'allow a named-key destructure whose default has an object rest',
            code: 'const { A = (({ ...rest }) => rest)({}) } = process.env;',
            expected: 0,
        },
        {
            description: 'allow a local variable that shadows process',
            code: 'const process = { env: {} };\nconst copy = { ...process.env };',
            expected: 0,
        },
        {
            description: 'allow taking its type',
            code: 'type Env = typeof process.env;',
            expected: 0,
        },
        {
            description: 'flag reaching it through a reassigned alias of process',
            code: 'let nodeProcess;\nnodeProcess = process;\nconst env = nodeProcess.env;',
            expected: 1,
        },
        {
            description:
                'flag both a nullish-coalesced alias of process and the require it falls back to',
            code: "const nodeProcess = globalThis.process ?? require('process');\nconst env = nodeProcess.env;",
            expected: 2,
        },
        {
            description: 'flag reaching it through a conditional alias of process',
            code: 'const nodeProcess = isCi ? process : fallback;\nconst env = nodeProcess.env;',
            expected: 1,
        },
        {
            description: 'flag reaching it through a parameter defaulting to process',
            code: 'const getEnv = (nodeProcess = process) => nodeProcess.env;',
            expected: 1,
        },
        {
            description: 'flag reaching it through a default import of process under another name',
            code: "import { default as nodeProcess } from 'process';\nconst env = nodeProcess.env;",
            expected: 1,
        },
        {
            description: 'flag reaching it through an import-equals require of process',
            code: "import nodeProcess = require('process');\nconst env = nodeProcess.env;",
            expected: 1,
        },
        {
            description: 'flag reaching it through process destructured off global',
            code: 'const { process: nodeProcess } = global;\nconst env = nodeProcess.env;',
            expected: 1,
        },
        {
            description: 'flag reaching it when only a type named process is declared',
            code: 'type process = { env: object };\nconst env = process.env;',
            expected: 1,
        },
        {
            description: 'flag reaching it through a declared process',
            code: 'declare const process: NodeJS.Process;\nconst env = process.env;',
            expected: 1,
        },
        {
            description: 'flag spreading it when process is only imported as a type',
            code: "import type { process } from './types';\nconst copy = { ...process.env };",
            expected: 1,
        },
        {
            description: 'flag spreading it when process is imported with an inline type modifier',
            code: "import { type process } from './types';\nconst copy = { ...process.env };",
            expected: 1,
        },
        {
            description: 'flag spreading it when process is only a default type import',
            code: "import type process from './types';\nconst copy = { ...process.env };",
            expected: 1,
        },
        {
            description: 'flag spreading it when process is only a namespace type import',
            code: "import type * as process from './types';\nconst copy = { ...process.env };",
            expected: 1,
        },
        {
            description: 'flag spreading it when process is only a type import-equals',
            code: "import type process = require('./types');\nconst copy = { ...process.env };",
            expected: 1,
        },
        {
            description:
                'allow a single-key jest.replaceProperty when jest is only imported as a type',
            code: "import type { jest } from './fakes';\njest.replaceProperty(process.env, 'A', 'x');",
            expected: 0,
        },
        {
            description: 'allow re-exporting a type-only namespace import of node:process',
            code: "import type * as nodeProcess from 'node:process';\nexport { nodeProcess };",
            expected: 0,
        },
        {
            description: 'allow default-exporting a type-only default import of process',
            code: "import type nodeProcess from 'process';\nexport default nodeProcess;",
            expected: 0,
        },
        {
            description: 'allow export-assigning a type-only import-equals of process',
            code: "import type nodeProcess = require('process');\nexport = nodeProcess;",
            expected: 0,
        },
        {
            description: 'allow a value import named process from another module',
            code: "import { process } from './fakes';\nconst copy = { ...process.env };",
            expected: 0,
        },
        {
            description: 'flag spreading it when a class named process is only declared',
            code: 'declare class process {\n    static env: Record<string, string>;\n}\nconst copy = { ...process.env };',
            expected: 1,
        },
        {
            description: 'flag spreading it when a function named process is only declared',
            code: 'declare function process(): void;\nconst copy = { ...process.env };',
            expected: 1,
        },
        {
            description: 'flag spreading it when an enum named process is only declared',
            code: 'declare enum process {}\nconst copy = { ...process.env };',
            expected: 1,
        },
        {
            description: 'flag spreading it when a namespace named process is only declared',
            code: 'declare namespace process {\n    const env: Record<string, string>;\n}\nconst copy = { ...process.env };',
            expected: 1,
        },
        {
            description:
                'allow binding the global object to a local, as browser code in Playwright specs does',
            code: 'const g = globalThis as any;\ng.flag = true;',
            expected: 0,
        },
        {
            description: 'allow passing a listener to process.once from a Promise executor',
            code: "await new Promise((resolve) => process.once('message', resolve));",
            expected: 0,
        },
        {
            description: 'allow a cleanup closure that returns process.off',
            code: "const off = () => process.off('exit', handler);\noff();",
            expected: 0,
        },
        {
            description: 'allow testing that it exists',
            code: 'if (process.env) {\n    run();\n}',
            expected: 0,
        },
        {
            description: 'allow guarding a key read with &&',
            code: 'const ci = process.env && process.env.CI;',
            expected: 0,
        },
        {
            description: 'allow destructuring named keys of a nullish-coalesced fallback',
            code: 'const { CI } = process.env ?? {};',
            expected: 0,
        },
        {
            description: 'allow reading a key off a conditional that may be it',
            code: 'const value = (useEnv ? process.env : defaults).SITE;',
            expected: 0,
        },
        {
            description: 'allow negating it',
            code: 'const missing = !process.env;',
            expected: 0,
        },
        {
            description: 'allow a keyed call on a renamed jest import',
            code: "import { jest as j } from '@jest/globals';\nj.spyOn(process, 'cwd');",
            expected: 0,
        },
        {
            description: 'allow a keyed call on a built-in read off globalThis',
            code: 'const names = globalThis.Object.keys(process.env);',
            expected: 0,
        },
        {
            description: 'flag reading a key of process.report',
            code: 'const reportDirectory = process.report.directory;',
            expected: 1,
        },
        {
            description: 'flag aliasing process even to read one key',
            code: 'const nodeProcess = process;\nconst platform = nodeProcess.platform;',
            expected: 1,
        },
        {
            description: 'flag storing process in a TypeScript parameter property',
            code: 'class Holder {\n    constructor(private proc = process) {}\n}',
            expected: 1,
        },
        {
            description: 'flag destructuring report off process',
            code: 'const { report } = process;',
            expected: 1,
        },
        {
            description: 'flag aliasing process.report',
            code: 'const nodeReport = process.report;\nnodeReport.getReport();',
            expected: 1,
        },
        {
            description: 'flag destructuring getReport off process.report',
            code: 'const { getReport } = process.report;',
            expected: 1,
        },
        {
            description: 'flag replacing it with a key behind a type assertion',
            code: "jest.replaceProperty(process, 'env' as never, {});",
            expected: 1,
        },
        {
            description: 'flag spying on it with a key behind as const',
            code: "jest.spyOn(process, 'env' as const, 'get');",
            expected: 1,
        },
        {
            description: 'flag spreading it read with a key behind a type assertion',
            code: "const copy = { ...process['env' as 'env'] };",
            expected: 1,
        },
        {
            description: 'flag exporting an import-equals of process',
            code: "export import nodeProcess = require('process');",
            expected: 1,
        },
        {
            description: 'flag assigning process to an ambient global',
            code: 'declare global {\n    var savedProcess: NodeJS.Process;\n}\nsavedProcess = process;\nexport {};',
            expected: 1,
        },
        {
            description: 'flag an import-equals alias of globalThis.process',
            code: 'import nodeProcess = globalThis.process;\nconst copy = { ...nodeProcess.env };',
            expected: 1,
        },
        {
            description: 'flag an import-equals alias of process',
            code: 'import nodeProcess = process;',
            expected: 1,
        },
        {
            description: 'flag writing a process report',
            code: "process.report.writeReport('report.json');",
            expected: 1,
        },
        {
            description: 'flag turning on process reports for fatal errors',
            code: 'process.report.reportOnFatalError = true;',
            expected: 1,
        },
        {
            description: 'flag testing that process.report exists',
            code: 'if (process.report) {\n    run();\n}',
            expected: 1,
        },
        {
            description: 'flag passing process to the call method of another object',
            code: 'rpc.call(process);',
            expected: 1,
        },
        {
            description: 'flag passing process to the bind method of another object',
            code: 'const send = ipc.bind(process);',
            expected: 1,
        },
        {
            description: 'flag spying on the global process getter',
            code: "jest.spyOn(globalThis, 'process', 'get');",
            expected: 1,
        },
        {
            description:
                'flag destructuring process off a conditional that may be the global object',
            code: 'const { process: nodeProcess } = useGlobal ? globalThis : process;',
            expected: 1,
        },
        {
            description: 'flag a require of process behind a type assertion',
            code: "const nodeProcess = (jest.requireActual as any)('process');",
            expected: 1,
        },
        {
            description: 'flag a require of process behind a non-null assertion',
            code: "const nodeProcess = require!('process');",
            expected: 1,
        },
        {
            description: 'flag a require of process called through a comma expression',
            code: "const nodeProcess = (0, require)('process');",
            expected: 1,
        },
        {
            description: 'flag binding process as this to a let local that was reassigned',
            code: 'let method = process.exit;\nmethod = function () {\n    return this;\n};\nconst bound = method.call(process);',
            expected: 1,
        },
        {
            description: 'flag binding process as this to a destructured method with a default',
            code: 'const { custom = function () { return this; } } = process;\nconst bound = custom.call(process);',
            expected: 1,
        },
        {
            description: 'flag deleting the global process with Reflect.deleteProperty',
            code: "Reflect.deleteProperty(globalThis, 'process');",
            expected: 1,
        },
        {
            description:
                'flag reaching process.report through an inherited __lookupGetter__ bound to process',
            code: "process.__lookupGetter__.call(process, 'report')().getReport();",
            expected: 2,
        },
        {
            description: 'flag redefining it with an inherited __defineGetter__',
            code: "process.__defineGetter__('env', () => ({}));",
            expected: 1,
        },
        {
            description: 'flag loading process with getBuiltinModule behind a non-null assertion',
            code: "const nodeProcess = process.getBuiltinModule!('process');",
            expected: 1,
        },
        {
            description:
                'flag a keyed call on a built-in read off something that may not be the global object',
            code: 'const names = (useGlobal ? globalThis : fake).Object.keys(process.env);',
            expected: 1,
        },
        {
            description:
                'flag binding process as this to a method of something that may not be process',
            code: '(useReal ? process : fake).emit.call(process);',
            expected: 1,
        },
        {
            description: 'allow a keyed call on a built-in read off global',
            code: 'const names = global.Object.keys(process.env);',
            expected: 0,
        },
        {
            description: 'flag destructuring an inherited accessor helper off process',
            code: 'const { __lookupGetter__ } = process;',
            expected: 1,
        },
        {
            description:
                'flag both an accessor helper destructured off its env and binding process to it',
            code: "const { env: { __lookupGetter__ } } = process;\n__lookupGetter__.call(process, 'report');",
            expected: 2,
        },
        {
            description:
                'flag a requireActual of process on something that may be the global object',
            code: "const nodeProcess = (useGlobal ? globalThis : fake).jest.requireActual('process');",
            expected: 1,
        },
        {
            description:
                'flag a Reflect.deleteProperty of the global process on something that may be the global object',
            code: "(useGlobal ? globalThis : fake).Reflect.deleteProperty(globalThis, 'process');",
            expected: 1,
        },
        {
            description: 'flag binding process as this to an accessor helper imported from process',
            code: "import { __lookupGetter__ } from 'process';\nconst report = __lookupGetter__.call(process, 'report')();",
            expected: 2,
        },
        {
            description:
                'flag binding process as this to an accessor helper destructured off process',
            code: "const { __defineGetter__ } = process;\n__defineGetter__.call(process, 'env', fn);",
            expected: 2,
        },
        {
            description:
                'allow a keyed call on a built-in read off a fallback between global objects',
            code: 'const names = (globalThis ?? global).Object.keys(process.env);',
            expected: 0,
        },
        {
            description: 'allow a hook read off a conditional between global objects',
            code: "(useGlobal ? global : globalThis).beforeEach(() => Object.assign(process.env, { X: '1' }));",
            expected: 0,
        },
        {
            description: 'flag both a let-destructured accessor helper and binding process to it',
            code: "let { __lookupGetter__ } = process;\n__lookupGetter__.call(process, 'env');",
            expected: 2,
        },
        {
            description:
                'flag both an accessor helper destructured off process in the global object and binding process to it',
            code: "const { process: { __lookupGetter__ } } = globalThis;\n__lookupGetter__.call(process, 'env');",
            expected: 2,
        },
        {
            description: 'flag reading an accessor helper off it',
            code: 'const lookup = process.env.__lookupGetter__;',
            expected: 1,
        },
        {
            description:
                'flag both an accessor helper destructured off another object and binding process to it',
            code: "const { __lookupGetter__ } = Object.prototype;\nconst report = __lookupGetter__.call(process, 'report')();",
            expected: 2,
        },
        {
            description: 'flag destructuring an accessor helper off it',
            code: 'const { __lookupGetter__ } = process.env;',
            expected: 1,
        },
        {
            description: 'flag replacing the global process with an accessor helper on globalThis',
            code: "globalThis.__defineGetter__('process', () => ({ env: {} }));",
            expected: 1,
        },
        {
            description: 'flag reaching the global process with an accessor helper on globalThis',
            code: "const env = globalThis.__lookupGetter__('process')().env;",
            expected: 1,
        },
        {
            description: 'flag both an accessor helper and passing it the env',
            code: "const getter = Object.prototype.__lookupGetter__.call(process.env, 'X');",
            expected: 2,
        },
        {
            description:
                'flag replacing the global process through an array destructuring assignment',
            code: '[process] = [fake];',
            expected: 1,
        },
        {
            description: 'flag replacing the global process as a for-of target',
            code: 'for (process of fakes) {\n    run();\n}',
            expected: 1,
        },
        {
            description: 'flag an accessor helper called through a tagged template',
            code: 'const getter = process.__lookupGetter__`report`;',
            expected: 1,
        },
        {
            description: 'flag the global accessor helper run on the global object',
            code: "const define = __defineGetter__;\ndefine.call(globalThis, 'process', () => fake);",
            expected: 1,
        },
        {
            description: 'flag an accessor helper kept in a local and run on the global object',
            code: "const lookup = Object.prototype.__lookupGetter__;\nconst getProcess = lookup.call(globalThis, 'process');",
            expected: 1,
        },
        {
            description: 'flag reading the global process through its property descriptor',
            code: "const env = Object.getOwnPropertyDescriptor(globalThis, 'process').value.env;",
            expected: 1,
        },
        {
            description: 'allow a type query of an accessor helper',
            code: 'type Lookup = typeof __defineGetter__;',
            expected: 0,
        },
        {
            description: 'flag re-exporting an accessor helper from process',
            code: "export { __lookupGetter__ as lookup } from 'process';",
            expected: 1,
        },
        {
            description: 'flag an accessor helper key in a function type',
            code: 'type Read = ({ __lookupGetter__ }: { __lookupGetter__: unknown }) => void;',
            expected: 1,
        },
        {
            description: 'allow a qualified type query of an accessor helper',
            code: 'type Call = typeof __lookupGetter__.call;',
            expected: 0,
        },
        {
            description: 'flag reading a flag of the global process descriptor',
            code: "const configurable = Object.getOwnPropertyDescriptor(globalThis, 'process')?.configurable;",
            expected: 1,
        },
        {
            description: 'flag both destructuring valueOf off process and binding process to it',
            code: 'const { valueOf } = process;\nconst nodeProcess = valueOf.call(process);',
            expected: 2,
        },
        {
            description: 'flag destructuring the value of the global process descriptor',
            code: "const { value } = Object.getOwnPropertyDescriptor(globalThis, 'process')!;",
            expected: 1,
        },
        {
            description:
                'flag using the result of a flag-only destructuring assignment of the global process descriptor',
            code: "let configurable;\nconst descriptor = ({ configurable } = Object.getOwnPropertyDescriptor(globalThis, 'process')!);",
            expected: 1,
        },
        {
            description: 'flag calling process.constructor, which returns process',
            code: 'const copy = { ...process.constructor().env };',
            expected: 1,
        },
        {
            description: 'flag binding process to process.constructor',
            code: 'const nodeProcess = process.constructor.call(process);',
            expected: 2,
        },
        {
            description: 'flag a separate leak on a later line inside a reported replacement',
            code: "jest.replaceProperty(process, 'env', {\n    PATH: '/bin',\n    LEAK: JSON.stringify(process.env),\n});",
            expected: 2,
        },
        {
            description: 'flag destructuring constructor off process',
            code: 'const { constructor: Construct } = process;',
            expected: 1,
        },
        {
            description: 'flag reading constructor off process with Reflect.get',
            code: "const construct = Reflect.get(process, 'constructor');",
            expected: 1,
        },
        {
            description: 'flag importing constructor from process',
            code: "import { constructor as Construct } from 'process';",
            expected: 1,
        },
        {
            description: 'flag destructuring constructor off process in the global object',
            code: 'const { process: { constructor: Construct } } = globalThis;',
            expected: 1,
        },
        {
            description: 'flag destructuring valueOf off process',
            code: 'const { valueOf } = process;',
            expected: 1,
        },
        {
            description: 'flag a wrapped replacement of it that spreads itself once',
            code: "process.env = {\n    ...process.env,\n    X: '1',\n};",
            expected: 1,
        },
        {
            description: 'flag a wrapped getter spy on it that returns a spread of itself once',
            code: "jest.spyOn(process, 'env', 'get')\n    .mockReturnValue({ ...process.env });",
            expected: 1,
        },
        {
            description: 'flag reading an accessor helper with Reflect.get',
            code: "const lookup = Reflect.get(Object.prototype, '__lookupGetter__');",
            expected: 1,
        },
        {
            description: "flag reading an accessor helper's descriptor",
            code: "const lookup = Object.getOwnPropertyDescriptor(Object.prototype, '__lookupGetter__');",
            expected: 1,
        },
        {
            description:
                'flag a spread of it on a later line into a reported spy on another method of process',
            code: "jest.spyOn(process, 'valueOf').mockReturnValue({\n    ...process.env,\n});",
            expected: 2,
        },
        {
            description:
                'flag a spread of it on a later line into a reported write to the global object',
            code: 'Object.assign(globalThis, {\n    ...process.env,\n});',
            expected: 2,
        },
        {
            description:
                'allow checking that an object lacks an accessor helper key with Object.hasOwn',
            code: "expect(Object.hasOwn(result, '__defineGetter__')).toBe(false);",
            expected: 0,
        },
        {
            description: 'allow checking for an accessor helper key with Reflect.has',
            code: "expect(Reflect.has(sanitized, '__lookupGetter__')).toBe(true);",
            expected: 0,
        },
        {
            description:
                "flag a spread of it on a later line nested in a replacement's descriptor on its own",
            code: "Object.defineProperty(process, 'env', {\n    value: {\n        ...process.env,\n    },\n});",
            expected: 2,
        },
        {
            description: 'allow keyed calls given no arguments',
            code: 'Reflect.get();\njest.replaceProperty();\nObject.defineProperties();',
            expected: 0,
        },
        {
            description: 'flag reading the prototype of process',
            code: 'const proto = Object.getPrototypeOf(process);',
            expected: 1,
        },
        {
            description: 'flag aliasing it with import =',
            code: 'declare namespace process {\n    const env: Record<string, string | undefined>;\n}\nimport env = process.env;',
            expected: 1,
        },
        {
            description: 'flag aliasing it off the global object with import =',
            code: 'import env = globalThis.process.env;',
            expected: 1,
        },
        {
            description: 'flag exporting an import = alias of it',
            code: 'declare namespace process {\n    const env: Record<string, string | undefined>;\n}\nexport import env = process.env;',
            expected: 1,
        },
        {
            description: 'flag aliasing process.report with import =',
            code: 'declare namespace process {\n    const report: { getReport(): object };\n}\nimport report = process.report;',
            expected: 1,
        },
        {
            description: 'flag aliasing process.valueOf with import =',
            code: 'declare namespace process {\n    const valueOf: () => object;\n}\nimport valueOf = process.valueOf;',
            expected: 1,
        },
        {
            description: 'flag aliasing an accessor helper with import =',
            code: 'import lookup = Object.prototype.__lookupGetter__;',
            expected: 1,
        },
        {
            description: 'allow aliasing a single key of process with import =',
            code: 'declare namespace process {\n    const platform: string;\n}\nimport platform = process.platform;',
            expected: 0,
        },
        {
            description: 'allow aliasing one key of it with import =',
            code: 'declare namespace process {\n    const env: Record<string, string | undefined>;\n}\nimport home = process.env.HOME;',
            expected: 0,
        },
        {
            description: 'allow aliasing one key of it off the global object with import =',
            code: 'import home = globalThis.process.env.HOME;',
            expected: 0,
        },
        {
            description: 'flag only the accessor helper in an import = alias of it',
            code: 'declare namespace process {\n    const env: Record<string, string | undefined>;\n}\nimport lookup = process.env.__lookupGetter__;',
            expected: 1,
        },
        {
            description: 'flag reading the whole env through its constructor',
            code: 'const copy = new process.env.constructor();',
            expected: 1,
        },
        {
            description: 'flag destructuring constructor off it',
            code: 'const { constructor: EnvView } = process.env;',
            expected: 1,
        },
        {
            description: 'flag reading constructor off it with Reflect.get',
            code: "const EnvView = Reflect.get(process.env, 'constructor');",
            expected: 1,
        },
        {
            description: 'flag destructuring valueOf off it',
            code: 'const { valueOf } = process.env;',
            expected: 1,
        },
        {
            description: 'flag reading valueOf off it with Reflect.get',
            code: "const read = Reflect.get(process.env, 'valueOf');",
            expected: 1,
        },
        {
            description: 'allow destructuring a key named like an ordinary variable off it',
            code: 'const { HOME, PATH } = process.env;',
            expected: 0,
        },
        {
            description: 'flag destructuring constructor off it in a nested pattern off process',
            code: 'const { env: { constructor: EnvView } } = process;',
            expected: 1,
        },
        {
            description:
                'flag destructuring constructor off it in a defaulted nested pattern off process',
            code: 'const { env: { constructor: EnvView } = {} } = process;',
            expected: 1,
        },
        {
            description:
                'flag destructuring constructor off it in a nested pattern off the global object',
            code: 'const { process: { env: { constructor: EnvView } } } = globalThis;',
            expected: 1,
        },
        {
            description: 'flag aliasing its constructor with import =',
            code: 'import EnvView = globalThis.process.env.constructor;',
            expected: 1,
        },
        {
            description: 'flag reading its prototype through __proto__',
            code: 'const proto = process.env.__proto__;',
            expected: 1,
        },
        {
            description: 'flag destructuring __proto__ off it',
            code: 'const { __proto__: proto } = process.env;',
            expected: 1,
        },
        {
            description: 'flag reading the prototype of process through __proto__',
            code: 'const proto = process.__proto__;',
            expected: 1,
        },
        {
            description: 'allow destructuring named keys off it in a nested pattern off process',
            code: 'const { env: { HOME } } = process;',
            expected: 0,
        },
        {
            description: 'flag a chained replacement that spreads itself once',
            code: "jest.replaceProperty(process, 'env', {\n    ...process.env,\n    X: '1',\n}).replaceValue({});",
            expected: 1,
        },
        {
            description: 'flag a three-call spy chain that spreads itself in a middle call once',
            code: "jest.spyOn(process, 'env', 'get')\n    .mockReturnValueOnce({ ...process.env, A: '1' })\n    .mockReturnValue({ ...process.env });",
            expected: 1,
        },
        {
            description: 'flag reading it off process.getBuiltinModule of process',
            code: "const env = process.getBuiltinModule('process').env;",
            expected: 1,
        },
        {
            description: 'flag reading it off an alias of process.getBuiltinModule of node:process',
            code: "const builtinProcess = process.getBuiltinModule('node:process');\nconsole.log(builtinProcess.env);",
            expected: 1,
        },
        {
            description: 'flag passing process.getBuiltinModule of process whole',
            code: "console.log(process.getBuiltinModule('process'));",
            expected: 1,
        },
        {
            description: 'allow getBuiltinModule of process on another object',
            code: "const env = loader.getBuiltinModule('process').env;\nconsole.log(env);",
            expected: 0,
        },
        {
            description: 'allow loading another built-in module with process.getBuiltinModule',
            code: "const fs = process.getBuiltinModule('fs');\nconsole.log(fs);",
            expected: 0,
        },
        {
            description: 'flag loading process with getBuiltinModule even to read one key',
            code: "const site = process.getBuiltinModule('process').env.DD_SITE;",
            expected: 1,
        },
        {
            description: 'allow a local function named process that has an overload signature',
            code: 'function process(): void;\nfunction process() {}\nconst copy = { ...process.env };',
            expected: 0,
        },
        {
            description: 'allow a local process inside a class with a declare field',
            code: 'class A {\n    declare x: string;\n    m() {\n        const process = { env: {} };\n        return { ...process.env };\n    }\n}',
            expected: 0,
        },
        {
            description: 'flag spreading it when process is declared inside a declare global block',
            code: 'declare global {\n    var process: NodeJS.Process;\n}\nconst copy = { ...process.env };\nexport {};',
            expected: 1,
        },
        {
            description: 'flag reaching it through satisfies',
            code: 'const env = (process satisfies NodeJS.Process).env;',
            expected: 1,
        },
        {
            description: 'flag reaching it through an angle-bracket type assertion',
            code: 'const env = (<NodeJS.Process>process).env;',
            expected: 1,
        },
        {
            description: 'flag deleting it',
            code: 'delete process.env;',
            expected: 1,
        },
        {
            description: 'flag using the result of Object.assign into it',
            code: "const copy = Object.assign(process.env, { DD_SITE: 'x' });",
            expected: 1,
        },
        {
            description: 'flag replacing it through Object.assign on process',
            code: 'Object.assign(process, { env: {} });',
            expected: 1,
        },
        {
            description: 'flag replacing it through Object.defineProperties on process',
            code: 'Object.defineProperties(process, { env: { value: {} } });',
            expected: 1,
        },
        {
            description: 'flag spreading process',
            code: 'const mockProcess = { ...process, exit: jest.fn() };',
            expected: 1,
        },
        {
            description: 'flag a rest destructure of process',
            code: 'const { stdout, ...rest } = process;',
            expected: 1,
        },
        {
            description: 'flag asserting on process whole',
            code: 'expect(process).toMatchObject({});',
            expected: 1,
        },
        {
            description: 'flag listing the entries of process',
            code: 'const entries = Object.entries(process);',
            expected: 1,
        },
        {
            description: 'flag serializing process',
            code: 'const text = JSON.stringify(process);',
            expected: 1,
        },
        {
            description: 'flag logging process',
            code: 'console.log(process);',
            expected: 1,
        },
        {
            description: 'allow spying on a process method',
            code: "jest.spyOn(process, 'exit');",
            expected: 0,
        },
        {
            description: 'allow redefining another process property',
            code: "Object.defineProperty(process, 'platform', { value: 'linux' });",
            expected: 0,
        },
        {
            description: 'allow replacing one key with jest.replaceProperty',
            code: "jest.replaceProperty(process.env, 'DD_SITE', 'datadoghq.eu');",
            expected: 0,
        },
        {
            description: 'allow assigning keys into it with Object.assign',
            code: "Object.assign(process.env, { DD_SITE: 'x' });",
            expected: 0,
        },
        {
            description: 'allow defining one key with Object.defineProperty',
            code: "Object.defineProperty(process.env, 'DD_SITE', { value: 'x' });",
            expected: 0,
        },
        {
            description: 'allow reading one key with Reflect.get',
            code: "const site = Reflect.get(process.env, 'DD_SITE');",
            expected: 0,
        },
        {
            description: 'allow deleting one key with Reflect.deleteProperty',
            code: "Reflect.deleteProperty(process.env, 'DD_SITE');",
            expected: 0,
        },
        {
            description: 'allow reading one key descriptor',
            code: "const descriptor = Object.getOwnPropertyDescriptor(process.env, 'DD_SITE');",
            expected: 0,
        },
        {
            description: 'allow checking its runtime type',
            code: 'const kind = typeof process.env;',
            expected: 0,
        },
        {
            description: 'allow assignment-destructuring named keys in a for initializer',
            code: 'let PATH;\nfor ({ PATH } = process.env; ; ) {\n    break;\n}',
            expected: 0,
        },
        {
            description: 'allow a local variable that shadows globalThis',
            code: 'const globalThis = { process: { env: {} } };\nconst copy = { ...globalThis.process.env };',
            expected: 0,
        },
        {
            description: 'allow a self-referencing variable',
            code: 'var nodeProcess = nodeProcess;\nconst value = nodeProcess.env;',
            expected: 0,
        },
        {
            description: 'allow destructuring other process properties',
            code: 'const { platform } = process;',
            expected: 0,
        },
        {
            description: 'allow a defaulted property destructured off process',
            code: "const { platform: currentPlatform = 'linux' } = process;\nexpect(currentPlatform).toBe('linux');",
            expected: 0,
        },
        {
            description: 'allow iterating the names of process',
            code: 'for (const key in process) {\n    console.log(key);\n}',
            expected: 0,
        },
        {
            description: 'allow a defaulted parameter property destructured off process',
            code: "function check({ platform: currentPlatform = 'x' } = process) {\n    expect(currentPlatform).toBe('x');\n}",
            expected: 0,
        },
        {
            description: 'flag replacing process through global',
            code: 'global.process = { env: {} };',
            expected: 1,
        },
        {
            description: 'flag replacing process directly',
            code: 'process = { env: {} };',
            expected: 1,
        },
        {
            description: 'flag replacing process with jest.replaceProperty',
            code: "jest.replaceProperty(globalThis, 'process', { env: {} });",
            expected: 1,
        },
        {
            description: 'flag replacing process with Object.defineProperty',
            code: "Object.defineProperty(global, 'process', { value: { env: {} } });",
            expected: 1,
        },
        {
            description: 'flag copying process with Object.assign',
            code: 'const copy = Object.assign({}, process);',
            expected: 1,
        },
        {
            description: 'flag copying the descriptors of process',
            code: 'const descriptors = Object.getOwnPropertyDescriptors(process);',
            expected: 1,
        },
        {
            description: 'allow assigning keys into it with an optional call',
            code: "Object.assign?.(process.env, { A: '1' });",
            expected: 0,
        },
        {
            description: 'allow assigning keys into it under void',
            code: "void Object.assign(process.env, { A: '1' });",
            expected: 0,
        },
        {
            description: 'allow assigning keys into it in a for update',
            code: 'for (;; Object.assign(process.env, {})) {\n    break;\n}',
            expected: 0,
        },
        {
            description: 'allow assignment-destructuring named keys before another expression',
            code: 'let PATH;\n({ PATH } = process.env, 1);',
            expected: 0,
        },
        {
            description: 'flag using the result of Object.defineProperty on it',
            code: "const defined = Object.defineProperty(process.env, 'A', { value: 'x' });",
            expected: 1,
        },
        {
            description: 'flag reaching it through Reflect.get on globalThis',
            code: "const nodeProcess = Reflect.get(globalThis, 'process');\nconst env = nodeProcess.env;",
            expected: 1,
        },
        {
            description: 'flag destructuring it off process nested in global',
            code: 'const { process: { env } } = global;',
            expected: 1,
        },
        {
            description: 'flag reaching it through a defaulted process destructured off global',
            code: 'const { process: nodeProcess = fallback } = global;\nconst env = nodeProcess.env;',
            expected: 1,
        },
        {
            description: 'allow exporting a local named env',
            code: 'const env = 1;\nexport { env };',
            expected: 0,
        },
        {
            description: 'allow a process key destructured off another object',
            code: 'const { process: other } = notGlobal;\nconst value = other.env;',
            expected: 0,
        },
        {
            description: 'allow logging another global destructured off global',
            code: 'const { setTimeout: wait } = global;\nconsole.log(wait);',
            expected: 0,
        },
        {
            description: 'flag a nested destructure that defaults to process',
            code: 'const { opts: { env } = process } = config;',
            expected: 1,
        },
        {
            description: 'flag a process key destructure that defaults to process',
            code: 'const { process: { env } = process } = {};',
            expected: 1,
        },
        {
            description: 'flag spreading the actual process module into a mock',
            code: "jest.mock('process', () => ({ ...jest.requireActual('process'), env: {} }));",
            expected: 1,
        },
        {
            description: 'flag reaching it through jest.requireActual',
            code: "const nodeProcess = jest.requireActual('process');\nconst copy = { ...nodeProcess.env };",
            expected: 1,
        },
        {
            description: 'flag replacing process through Object.assign on global',
            code: 'Object.assign(global, { process: { env: {} } });',
            expected: 1,
        },
        {
            description: 'flag replacing process through Object.defineProperties on globalThis',
            code: 'Object.defineProperties(globalThis, { process: { value: {} } });',
            expected: 1,
        },
        {
            description: 'flag reaching it through process assignment-destructured off global',
            code: 'let nodeProcess;\n({ process: nodeProcess } = global);\nconst copy = { ...nodeProcess.env };',
            expected: 1,
        },
        {
            description:
                'flag reaching it through process destructured off global in a parameter default',
            code: 'function getEnv({ process: nodeProcess } = global) {\n    return { ...nodeProcess.env };\n}',
            expected: 1,
        },
        {
            description: 'flag replacing process with Reflect.set',
            code: "Reflect.set(globalThis, 'process', {});",
            expected: 1,
        },
        {
            description: 'flag replacing process with Reflect.defineProperty',
            code: "Reflect.defineProperty(global, 'process', { value: {} });",
            expected: 1,
        },
        {
            description: 'flag cloning process',
            code: 'const clone = structuredClone(process);',
            expected: 1,
        },
        {
            description: 'flag inspecting process with util.inspect',
            code: 'const text = util.inspect(process);',
            expected: 1,
        },
        {
            description: 'flag inspecting process with inspect',
            code: 'const text = inspect(process);',
            expected: 1,
        },
        {
            description: 'flag listing the values of process',
            code: 'const values = Object.values(process);',
            expected: 1,
        },
        {
            description: 'allow assigning keys into it in a concise hook callback',
            code: "beforeEach(() => Object.assign(process.env, { DD_SITE: 'x' }));",
            expected: 0,
        },
        {
            description: 'allow defining keys with Object.defineProperties',
            code: "Object.defineProperties(process.env, { A: { value: '1' } });",
            expected: 0,
        },
        {
            description: 'allow a type-only import of env',
            code: "import type { env } from 'process';",
            expected: 0,
        },
        {
            description: 'allow setting one key with Reflect.set',
            code: "Reflect.set(process.env, 'DD_SITE', 'x');",
            expected: 0,
        },
        {
            description: 'allow defining one key with Reflect.defineProperty',
            code: "Reflect.defineProperty(process.env, 'DD_SITE', { value: 'x' });",
            expected: 0,
        },
        {
            description: 'allow reading one key descriptor with Reflect',
            code: "const descriptor = Reflect.getOwnPropertyDescriptor(process.env, 'DD_SITE');",
            expected: 0,
        },
        {
            description: 'flag returning it from a concise test callback',
            code: "it('sets the site', () => Object.assign(process.env, { DD_SITE: 'x' }));",
            expected: 1,
        },
        {
            description: 'flag returning it from a concise hook callback that takes done',
            code: "beforeEach((done) => Object.assign(process.env, { A: '1' }));",
            expected: 1,
        },
        {
            description: 'flag returning it from a concise callback passed to another function',
            code: "run(() => Object.assign(process.env, { A: '1' }));",
            expected: 1,
        },
        {
            description: 'flag using the result of Object.defineProperties on it',
            code: "const defined = Object.defineProperties(process.env, { A: { value: '1' } });",
            expected: 1,
        },
        {
            description: 'flag reaching it through jest.requireMock',
            code: "const nodeProcess = jest.requireMock('process');\nconst copy = { ...nodeProcess.env };",
            expected: 1,
        },
        {
            description: 'allow an inline type-only import of env',
            code: "import { type env } from 'process';",
            expected: 0,
        },
        {
            description: 'allow a type-only re-export of env',
            code: "export type { env } from 'process';",
            expected: 0,
        },
        {
            description: 'flag reaching it through the default export of a dynamic import',
            code: "const env = (await import('process')).default.env;",
            expected: 1,
        },
        {
            description: 'flag destructuring the default export of a dynamic import',
            code: "const { default: nodeProcess } = await import('process');\nconst copy = { ...nodeProcess.env };",
            expected: 1,
        },
        {
            description: 'allow an inline type-only re-export of env',
            code: "export { type env } from 'process';",
            expected: 0,
        },
        {
            description: 'flag returning it from a concise arrow that is not a callback',
            code: "const setSite = () => Object.assign(process.env, { A: '1' });",
            expected: 1,
        },
        {
            description: 'allow returning it from a block-body hook callback',
            code: "beforeEach(() => {\n    return Object.assign(process.env, { A: '1' });\n});",
            expected: 0,
        },
        {
            description: 'allow returning it from a function-expression hook callback',
            code: "beforeEach(function () {\n    return Object.assign(process.env, { A: '1' });\n});",
            expected: 0,
        },
        {
            description: 'flag returning it from a block-body test callback',
            code: "it('sets the site', () => {\n    return Object.assign(process.env, { A: '1' });\n});",
            expected: 1,
        },
        {
            description: 'allow mutually referencing aliases',
            code: 'let first = second;\nlet second = first;\nconst copy = { ...first.process.env };',
            expected: 0,
        },
        {
            description: 'allow mutually referencing default aliases',
            code: 'let first = second.default;\nlet second = first.default;\nconst copy = { ...first.env };',
            expected: 0,
        },
        {
            description: 'flag returning it from a nested callback inside a hook',
            code: 'beforeEach(() => {\n    const copies = items.map(() => {\n        return Object.assign(process.env, {});\n    });\n    use(copies);\n});',
            expected: 1,
        },
        {
            description: 'flag returning it from a block-body hook callback that takes done',
            code: "beforeEach(function (done) {\n    return Object.assign(process.env, { A: '1' });\n});",
            expected: 1,
        },
        {
            description: 'flag returning it from a locally bound hook',
            code: "const { beforeAll } = test;\nbeforeAll(() => Object.assign(process.env, { A: '1' }));",
            expected: 1,
        },
        {
            description: 'allow returning it from a hook imported from @jest/globals',
            code: "import { beforeEach } from '@jest/globals';\nbeforeEach(() => Object.assign(process.env, { DD_SITE: 'x' }));",
            expected: 0,
        },
        {
            description: 'flag returning it from a hook-named import from another module',
            code: "import { beforeEach } from './hooks';\nbeforeEach(() => Object.assign(process.env, { A: '1' }));",
            expected: 1,
        },
        {
            description: 'flag returning it from a default import named like a hook',
            code: "import beforeEach from '@jest/globals';\nbeforeEach(() => Object.assign(process.env, { A: '1' }));",
            expected: 1,
        },
        {
            description: 'flag returning it from another export imported under a hook name',
            code: "import { expect as beforeEach } from '@jest/globals';\nbeforeEach(() => Object.assign(process.env, { A: '1' }));",
            expected: 1,
        },
        {
            description: 'allow replacing another global with jest.replaceProperty',
            code: "jest.replaceProperty(globalThis, 'fetch', jest.fn());",
            expected: 0,
        },
        {
            description: 'allow redefining another global with Object.defineProperty',
            code: "Object.defineProperty(global, 'navigator', { value: {} });",
            expected: 0,
        },
        {
            description: 'allow stubbing another global with Object.assign',
            code: 'Object.assign(global, { fetch: jest.fn() });',
            expected: 0,
        },
        {
            description: 'allow setting another process property with Object.assign',
            code: 'Object.assign(process, { exitCode: 1 });',
            expected: 0,
        },
        {
            description: 'allow reading env off a default import from another module',
            code: "import config from './config';\nconst value = config.env;",
            expected: 0,
        },
        {
            description: 'allow reading env off a namespace import from another module',
            code: "import * as settings from './settings';\nconst value = settings.env;",
            expected: 0,
        },
        {
            description: 'allow importing env from another module',
            code: "import { env } from './testConfig';",
            expected: 0,
        },
        {
            description: 'allow re-exporting env from another module',
            code: "export { env } from './fixtures';",
            expected: 0,
        },
        {
            description: 'allow reading env off another required module',
            code: "const value = require('./config').env;",
            expected: 0,
        },
        {
            description: 'allow reading env off another actual module',
            code: "const actual = jest.requireActual('../env');\nconst value = actual.env;",
            expected: 0,
        },
        {
            description: 'allow reading env off another dynamically imported module',
            code: "const value = (await import('./config')).env;",
            expected: 0,
        },
        {
            description: 'allow reassigning a local variable named process',
            code: 'let process = { env: {} };\nprocess = { env: {} };',
            expected: 0,
        },
        {
            description: 'allow assigning a process property on another object',
            code: 'config.process = {};',
            expected: 0,
        },
        {
            description: 'allow reading a process key off another object with Reflect.get',
            code: "const other = Reflect.get(config, 'process');\nconst value = other.env;",
            expected: 0,
        },
        {
            description: 'allow reading another global with Reflect.get',
            code: "const fetcher = Reflect.get(globalThis, 'fetch');\nconst value = fetcher.env;",
            expected: 0,
        },
        {
            description: 'flag destructuring it in a then callback of a dynamic import',
            code: "import('node:process').then(({ env }) => console.log(env));",
            expected: 1,
        },
        {
            description: 'flag reaching it through a then callback parameter of a dynamic import',
            code: "import('process').then((nodeProcess) => console.log(nodeProcess.env));",
            expected: 1,
        },
        {
            description: 'flag reaching it through an awaited alias of a dynamic import',
            code: "const loading = import('process');\nconst nodeProcess = await loading;\nconst copy = { ...nodeProcess.env };",
            expected: 1,
        },
        {
            description: 'flag passing process to a function',
            code: 'consume(process);',
            expected: 1,
        },
        {
            description: 'flag returning process',
            code: 'const getProcess = () => {\n    return process;\n};',
            expected: 1,
        },
        {
            description: 'flag logging process inside an object',
            code: 'console.log({ process });',
            expected: 1,
        },
        {
            description: 'flag exporting process',
            code: 'export default process;',
            expected: 1,
        },
        {
            description: 'flag assigning process to a property',
            code: 'module.exports = process;',
            expected: 1,
        },
        {
            description: 'flag putting process in an array',
            code: 'const list = [process];',
            expected: 1,
        },
        {
            description: 'flag asserting on process inside an object',
            code: 'expect({ process }).toEqual({});',
            expected: 1,
        },
        {
            description: 'flag an alias of process and replacing global process with it separately',
            code: 'const originalProcess = process;\nglobal.process = originalProcess;',
            expected: 2,
        },
        {
            description: 'allow listening to a process event',
            code: "process.on('exit', handler);",
            expected: 0,
        },
        {
            description: 'allow asserting on one process property',
            code: 'expect(process.exitCode).toBe(0);',
            expected: 0,
        },
        {
            description: 'allow comparing process',
            code: 'const isSame = target === process;',
            expected: 0,
        },
        {
            description: 'allow checking for a process key',
            code: "const hasEnv = 'env' in process;",
            expected: 0,
        },
        {
            description: 'flag passing process to a Symbol.hasInstance through instanceof',
            code: 'const matched = process instanceof Matcher;',
            expected: 1,
        },
        {
            description: 'allow comparing process by identity',
            code: 'const isSame = process === candidate;',
            expected: 0,
        },
        {
            description: 'flag checking whether an object is an instance of process',
            code: 'const isProcess = candidate instanceof process.constructor;',
            expected: 1,
        },
        {
            description: 'allow listing the names of process',
            code: 'const names = Object.keys(process);',
            expected: 0,
        },
        {
            description: 'allow testing process for truthiness',
            code: 'if (process) {\n    run();\n}',
            expected: 0,
        },
        {
            description: 'allow negating process',
            code: 'const missing = !process;',
            expected: 0,
        },
        {
            description: 'flag passing an assignment of process',
            code: 'let nodeProcess;\nfoo((nodeProcess = process));',
            expected: 1,
        },
        {
            description: 'flag asserting on an assignment-destructure of process',
            code: 'let platform;\nexpect(({ platform } = process)).toBe(1);',
            expected: 1,
        },
        {
            description: 'flag asserting on a promise for the process module',
            code: "expect(import('process')).resolves.toEqual({});",
            expected: 1,
        },
        {
            description: 'flag passing the process module to a then callback by reference',
            code: "import('process').then(console.log);",
            expected: 1,
        },
        {
            description: 'flag exporting an alias of process',
            code: 'export const exportedProcess = process;',
            expected: 1,
        },
        {
            description: 'flag re-exporting everything from process',
            code: "export * from 'process';",
            expected: 1,
        },
        {
            description: 'flag re-exporting the default export of process',
            code: "export { default } from 'process';",
            expected: 1,
        },
        {
            description: 'flag printing a process report',
            code: "expect(JSON.stringify(process.report.getReport())).toContain('x');",
            expected: 1,
        },
        {
            description:
                'flag an alias of process and replacing global process with it through jest.replaceProperty separately',
            code: "const originalProcess = process;\njest.replaceProperty(global, 'process', originalProcess);",
            expected: 2,
        },
        {
            description:
                'flag an alias of process and replacing global process with it through Object.assign separately',
            code: 'const originalProcess = process;\nObject.assign(globalThis, { process: originalProcess });',
            expected: 2,
        },
        {
            description: 'flag replacing it with Object.defineProperty and keeping the result once',
            code: "const defined = Object.defineProperty(process, 'env', { value: {} });",
            expected: 1,
        },
        {
            description: 'flag binding process to one of its own methods',
            code: 'const realExit = process.exit.bind(process);',
            expected: 1,
        },
        {
            description: 'allow guarding a key read with process &&',
            code: "const isCi = process && process.env.CI;\nexpect(isCi).toBe('1');",
            expected: 0,
        },
        {
            description: 'flag an awaited dynamic import of process even when only a key is used',
            code: "const loading = import('process');\nconst nodeProcess = await loading;\nnodeProcess.exit(0);",
            expected: 1,
        },
        {
            description: 'flag spreading process into a value that replaces global process once',
            code: "Object.defineProperty(globalThis, 'process', { value: { ...process, env: {} } });",
            expected: 1,
        },
        {
            description: 'flag spreading process into a jest.replaceProperty replacement once',
            code: "jest.replaceProperty(global, 'process', { ...process, env: {} });",
            expected: 1,
        },
        {
            description: 'flag spreading process into an assignment to global process once',
            code: 'global.process = { ...process, env: {} };',
            expected: 1,
        },
        {
            description: 'flag spreading it into its own replacement once',
            code: "jest.replaceProperty(process, 'env', { ...process.env, DD_SITE: 'x' });",
            expected: 1,
        },
        {
            description: 'flag exporting env destructured off process once',
            code: 'export const { env } = process;',
            expected: 1,
        },
        {
            description: 'flag copying process with valueOf',
            code: 'const copy = process.valueOf();',
            expected: 1,
        },
        {
            description: 'flag deleting global process',
            code: 'delete global.process;',
            expected: 1,
        },
        {
            description: 'flag a then callback parameter with a default',
            code: "import('process').then((nodeProcess = fallback) => consume(nodeProcess));",
            expected: 1,
        },
        {
            description: 'allow exporting a named key destructured off process',
            code: 'export const { platform } = process;',
            expected: 0,
        },
        {
            description: 'allow exporting a named env key destructured off process',
            code: 'export const { env: { DD_SITE } } = process;',
            expected: 0,
        },
        {
            description: 'allow testing process in a conditional',
            code: 'const pick = process ? first : second;',
            expected: 0,
        },
        {
            description: 'allow testing process in a while loop',
            code: 'while (process) {\n    break;\n}',
            expected: 0,
        },
        {
            description: 'flag a discarded dynamic import of process',
            code: "import('process');",
            expected: 1,
        },
        {
            description: 'allow a type-only re-export of everything from process',
            code: "export type * from 'process';",
            expected: 0,
        },
        {
            description: 'flag assigning a dynamic import of process to a local',
            code: "let loading;\nloading = import('process');",
            expected: 1,
        },
        {
            description: 'flag exporting process through a default key off a dynamic import',
            code: "export const { default: nodeProcess } = await import('node:process');",
            expected: 1,
        },
        {
            description: 'flag exporting a binding later assigned the process module',
            code: "export let nodeProcess;\nbeforeAll(async () => {\n    nodeProcess = await import('process');\n});",
            expected: 1,
        },
        {
            description: 'flag exporting a binding later assigned a promise for the process module',
            code: "export let loading;\nloading = import('process');",
            expected: 1,
        },
        {
            description: 'flag exporting an alias of process by name',
            code: 'const nodeProcess = process;\nexport { nodeProcess };',
            expected: 1,
        },
        {
            description: 'flag using an assignment of a promise for the process module',
            code: "let loading;\nconst used = (loading = import('process'));",
            expected: 1,
        },
        {
            description: 'flag reaching it through a promise alias assigned after declaration',
            code: "let loading;\nloading = import('process');\nconst nodeProcess = await loading;\nconst copy = { ...nodeProcess.env };",
            expected: 1,
        },
        {
            description: 'flag applying a function the rule cannot identify on process',
            code: 'const wrap = (original) => (...args) => original.apply(process, args);',
            expected: 1,
        },
        {
            description: 'flag lazily assigning a dynamic import of process',
            code: "let loading;\nloading ??= import('process');\nconst nodeProcess = await loading;\nnodeProcess.exit(0);",
            expected: 1,
        },
        {
            description: 'flag reassigning it with a spread of itself once',
            code: "process.env = { ...process.env, A: '1' };",
            expected: 1,
        },
        {
            description: 'flag mocking its getter with a spread of itself once',
            code: "jest.spyOn(process, 'env', 'get').mockReturnValue({ ...process.env, DD_SITE: 'x' });",
            expected: 1,
        },
        {
            description: 'flag using a logical assignment of a promise alias',
            code: "let loading = import('process');\nconsume((loading ||= other));",
            expected: 1,
        },
        {
            description: 'flag using a logical assignment of a process alias',
            code: 'let nodeProcess = process;\nconst value = (nodeProcess ||= fallback);\nconsole.log(value);',
            expected: 1,
        },
        {
            description: 'allow returning an emitter method result from a hook',
            code: "afterEach(() => process.removeAllListeners('exit'));",
            expected: 0,
        },
        {
            description: 'allow chaining emitter methods on process',
            code: "process.on('exit', first).on('exit', second);",
            expected: 0,
        },
        {
            description: 'allow an exported declaration of process',
            code: 'export declare const process: NodeJS.Process;',
            expected: 0,
        },
        {
            description: 'allow testing process in a do-while loop',
            code: 'do {\n    break;\n} while (process);',
            expected: 0,
        },
        {
            description: 'flag replacing process properties from a variable',
            code: 'Object.assign(process, replacement);',
            expected: 1,
        },
        {
            description: 'flag replacing process properties from a spread',
            code: 'Object.assign(process, { ...replacement });',
            expected: 1,
        },
        {
            description: 'flag replacing process properties from a computed key',
            code: 'Object.assign(process, { [key]: value });',
            expected: 1,
        },
        {
            description: 'flag defining process properties from a variable',
            code: 'Object.defineProperties(process, descriptors);',
            expected: 1,
        },
        {
            description: 'flag replacing global properties from a variable',
            code: 'Object.assign(globalThis, replacement);',
            expected: 1,
        },
        {
            description: 'flag replacing global properties from a spread',
            code: 'Object.assign(global, { ...replacement });',
            expected: 1,
        },
        {
            description: 'flag defining global properties from a variable',
            code: 'Object.defineProperties(globalThis, descriptors);',
            expected: 1,
        },
        {
            description: 'flag passing it to a local function named like a name reader',
            code: 'const Object = { keys: (value) => expect(value).toEqual({}) };\nObject.keys(process.env);',
            expected: 1,
        },
        {
            description: 'flag passing it to a local object named like jest',
            code: "const jest = { replaceProperty: consume };\njest.replaceProperty(process.env, 'A', 'x');",
            expected: 1,
        },
        {
            description: 'flag reaching the process module through a rest parameter',
            code: "import('process').then((...args) => expect(args[0].env).toEqual({}));",
            expected: 1,
        },
        {
            description: 'flag reaching the process module through arguments',
            code: "import('process').then(function () {\n    consume(arguments[0]);\n});",
            expected: 1,
        },
        {
            description: 'allow a local function named require',
            code: "const require = (name) => fake(name);\nconst value = require('process').env;",
            expected: 0,
        },
        {
            description: 'allow jest imported from @jest/globals',
            code: "import { jest } from '@jest/globals';\njest.replaceProperty(process.env, 'DD_SITE', 'x');",
            expected: 0,
        },
        {
            description: 'flag a dynamic import of process whose then callback ignores it',
            code: "import('process').then(() => run());",
            expected: 1,
        },
        {
            description: 'allow importing something else from process',
            code: "import { cwd } from 'process';",
            expected: 0,
        },
        {
            description: 'allow checking for a key with Object.hasOwn',
            code: "const hasSite = Object.hasOwn(process.env, 'DD_SITE');",
            expected: 0,
        },
        {
            description: 'allow checking for a key with Reflect.has',
            code: "const hasSite = Reflect.has(process.env, 'DD_SITE');",
            expected: 0,
        },
        {
            description: 'allow iterating its names',
            code: 'const names = [];\nfor (const name in process.env) {\n    names.push(name);\n}',
            expected: 0,
        },
        {
            description: 'allow a named-key destructure whose default has a rest parameter',
            code: 'const { A = ((...args) => args)() } = process.env;',
            expected: 0,
        },
        {
            description: 'allow listing its names',
            code: 'const names = Object.keys(process.env);',
            expected: 0,
        },
        {
            description: 'flag listing its values',
            code: 'const values = Object.values(process.env);',
            expected: 1,
        },
        {
            description: 'flag listing its entries',
            code: 'const entries = Object.entries(process.env);',
            expected: 1,
        },
        {
            description: 'allow checking for a key',
            code: "const hasSite = 'DD_SITE' in process.env;",
            expected: 0,
        },
    ];

    test.each(cases)('Should $description in a test file', async ({ code, expected }) => {
        const violations = await countProcessEnvViolations(code, TEST_FILE_PATH);
        expect(violations).toBe(expected);
    });

    const scopeCases = [
        {
            description: 'apply to Jest tests',
            file: 'packages/plugins/example/src/a.test.ts',
            expected: 1,
        },
        {
            description: 'apply to Playwright specs',
            file: 'packages/tests/src/e2e/a/a.spec.ts',
            expected: 1,
        },
        {
            description: 'apply to Playwright helpers',
            file: 'packages/tests/src/_playwright/a.ts',
            expected: 1,
        },
        {
            description: 'apply to plugin benchmark scripts',
            file: 'packages/plugins/live-debugger/scripts/benchmark-subset.js',
            expected: 1,
        },
        {
            description: 'apply to Playwright fixture projects',
            file: 'packages/tests/src/e2e/appsPlugin/project/greet.backend.js',
            expected: 1,
        },
        {
            description: 'apply to benchmarks',
            file: 'packages/tests/src/bench/a/a.bench.ts',
            expected: 1,
        },
        {
            description: 'apply to Jest helpers',
            file: 'packages/tests/src/_jest/helpers/a.ts',
            expected: 1,
        },
        {
            description: 'apply to the Jest config',
            file: 'packages/tests/jest.config.ts',
            expected: 1,
        },
        {
            description: 'apply to the Playwright configs',
            file: 'packages/tests/playwright.live-debugger-runtime.config.ts',
            expected: 1,
        },
        {
            description: 'skip source files',
            file: 'packages/plugins/example/src/a.ts',
            expected: 0,
        },
        {
            description: 'apply to the benchmark CLI scripts',
            file: 'packages/tests/src/bench/liveDebuggerRuntime/preflight.js',
            expected: 1,
        },
        {
            description: 'apply to Jest fixture files',
            file: 'packages/plugins/apps/src/vite/local-execution.process-exit.fixture.ts',
            expected: 1,
        },
        {
            description: 'apply to Jest fixtures modules',
            file: 'packages/plugins/apps/src/vite/local-execution.fixtures.ts',
            expected: 1,
        },
    ];

    test.each(scopeCases)('Should $description', async ({ file, expected }) => {
        const filePath = path.join(REPO_ROOT, file);
        const violations = await countProcessEnvViolations(
            'const copy = { ...process.env };',
            filePath,
        );
        expect(violations).toBe(expected);
    });
});
