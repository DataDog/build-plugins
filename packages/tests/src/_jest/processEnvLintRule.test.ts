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
        (message) =>
            message.ruleId === 'no-restricted-syntax' && message.message.includes('process.env'),
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
            description: 'allow assigning keys into it with Object.assign',
            code: "Object.assign(process.env, { DD_SITE: 'datadoghq.com' });",
            expected: 0,
        },
        {
            description: 'flag copying it into another object with an Object.assign statement',
            code: 'Object.assign(target, process.env);',
            expected: 1,
        },
        {
            description: 'flag returning Object.assign into it from a concise arrow',
            code: 'const setEnv = (values) => Object.assign(process.env, values);',
            expected: 1,
        },
        {
            description: 'flag Object.assign into it inside a sequence expression',
            code: 'const value = (Object.assign(process.env, {}), 1);',
            expected: 1,
        },
        {
            description: 'flag using the result of Object.assign into it',
            code: 'const copy = Object.assign(process.env, {});',
            expected: 1,
        },
        {
            description: 'flag a rest destructure of it',
            code: 'const { PATH, ...rest } = process.env;',
            expected: 1,
        },
        {
            description: 'flag passing it to a function',
            code: 'doSomething(process.env);',
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
        {
            description: 'flag storing the value of a destructuring assignment from it',
            code: 'const result = ({ PATH } = process.env);',
            expected: 1,
        },
        {
            description: 'flag returning a destructuring assignment from it from a concise arrow',
            code: 'const read = () => ({ PATH } = process.env);',
            expected: 1,
        },
        {
            description: 'allow a destructuring assignment statement of named keys',
            code: 'let PATH;\n({ PATH } = process.env);',
            expected: 0,
        },
        {
            description: 'flag importing it by name',
            code: "import { env } from 'process';",
            expected: 1,
        },
        {
            description: 'flag importing it by name from node:process under another name',
            code: "import { env as nodeEnv } from 'node:process';",
            expected: 1,
        },
        {
            description: 'allow importing another key by name',
            code: "import { platform } from 'process';",
            expected: 0,
        },
        {
            description: 'allow a type-only import of it',
            code: "import type { env } from 'process';",
            expected: 0,
        },
        {
            description: 'flag reading it off a require of process',
            code: "const copy = require('process').env;",
            expected: 1,
        },
        {
            description: 'flag destructuring it off a require of process',
            code: "const { env } = require('node:process');",
            expected: 1,
        },
        {
            description: 'allow reading one key off a require of process',
            code: "const home = require('process').env.HOME;",
            expected: 0,
        },
        {
            description: 'allow destructuring named keys off a require of process',
            code: "const { env: { HOME } } = require('process');",
            expected: 0,
        },
        {
            description: 'flag reading it off globalThis.process',
            code: 'const copy = { ...globalThis.process.env };',
            expected: 1,
        },
        {
            description: 'flag reading it off global.process',
            code: 'const copy = { ...global.process.env };',
            expected: 1,
        },
        {
            description: 'flag destructuring it off globalThis.process',
            code: 'const { env } = globalThis.process;',
            expected: 1,
        },
        {
            description: 'allow reading one key off globalThis.process',
            code: 'const home = globalThis.process.env.HOME;',
            expected: 0,
        },
        {
            description: 'allow destructuring named keys off global.process',
            code: 'const { env: { HOME } } = global.process;',
            expected: 0,
        },
        {
            description: 'allow replacing one key with jest.replaceProperty',
            code: "jest.replaceProperty(process.env, 'DD_SITE', 'datadoghq.eu');",
            expected: 0,
        },
        {
            description: 'flag setting a key to it with jest.replaceProperty',
            code: "jest.replaceProperty(process.env, 'COPY', process.env);",
            expected: 1,
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
            description: 'allow checking for a key with hasOwnProperty.call',
            code: "const hasSite = Object.prototype.hasOwnProperty.call(process.env, 'DD_SITE');",
            expected: 0,
        },
        {
            description: 'allow listing its names with for...in',
            code: 'for (const key in process.env) {\n    delete process.env[key];\n}',
            expected: 0,
        },
        {
            description: 'flag iterating over it with for...of',
            code: 'for (const entry of process.env) {\n    console.log(entry);\n}',
            expected: 1,
        },
        {
            description: 'allow a computed key held in a variable named env',
            code: "const env = 'PATH';\nconst value = process[env];",
            expected: 0,
        },
        {
            description: 'allow destructuring a computed key held in a variable named env',
            code: "const env = 'PATH';\nconst { [env]: value } = process;",
            expected: 0,
        },
        {
            description: 'allow Reflect.get with a key held in a variable named env',
            code: "const env = 'PATH';\nconst value = Reflect.get(process, env);",
            expected: 0,
        },
        {
            description: 'allow a non-null assertion before a key access',
            code: 'const home = process.env!.HOME;',
            expected: 0,
        },
        {
            description: 'allow a type assertion before a key access',
            code: 'const home = (process.env as Record<string, string>).HOME;',
            expected: 0,
        },
        {
            description: 'flag spreading it through a non-null assertion',
            code: 'const copy = { ...process.env! };',
            expected: 1,
        },
        {
            description: 'flag destructuring it off process in a parameter default',
            code: 'const read = ({ env } = process) => env;',
            expected: 1,
        },
        {
            description: 'allow destructuring named keys off process in a parameter default',
            code: 'const read = ({ env: { HOME } } = process) => HOME;',
            expected: 0,
        },
        {
            description: 'allow destructuring named keys off it in a parameter default',
            code: 'const read = ({ HOME } = process.env) => HOME;',
            expected: 0,
        },
        {
            description: 'flag a rest destructure of it in a parameter default',
            code: 'const read = ({ ...rest } = process.env) => rest;',
            expected: 1,
        },
        {
            description: 'allow a type assertion and a non-null assertion before a key access',
            code: 'const home = (process.env as Record<string, string>)!.HOME;',
            expected: 0,
        },
        {
            description: 'allow a satisfies check before a key access',
            code: 'const home = (process.env satisfies NodeJS.ProcessEnv).HOME;',
            expected: 0,
        },
        {
            description: 'flag spreading it through two TypeScript wrappers',
            code: 'const copy = { ...(process.env as Record<string, string>)! };',
            expected: 1,
        },
        {
            description: 'flag replacing it with Object.assign onto process',
            code: 'Object.assign(process, { env: {} });',
            expected: 1,
        },
        {
            description: 'flag replacing it with Object.defineProperties onto process',
            code: 'Object.defineProperties(process, { env: { value: {} } });',
            expected: 1,
        },
        {
            description: 'allow assigning another key onto process with Object.assign',
            code: 'Object.assign(process, { exitCode: 1 });',
            expected: 0,
        },
        {
            description: 'allow an angle-bracket type assertion before a key access',
            code: 'const home = (<Record<string, string>>process.env).HOME;',
            expected: 0,
        },
        {
            description: 'flag spreading it through an angle-bracket type assertion',
            code: 'const copy = { ...(<Record<string, string>>process.env) };',
            expected: 1,
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
            description: 'apply to benchmarks',
            file: 'packages/tests/src/bench/a/a.bench.ts',
            expected: 1,
        },
        {
            description: 'apply to benchmark setup and reporters',
            file: 'packages/tests/src/bench/liveDebuggerRuntime/globalSetup.ts',
            expected: 1,
        },
        {
            description: 'apply to benchmark JavaScript the benchmarks import',
            file: 'packages/tests/src/bench/liveDebuggerRuntime/liveDebuggerBenchConfig.js',
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
            description: 'skip benchmark CLI scripts',
            file: 'packages/tests/src/bench/liveDebuggerRuntime/preflight.js',
            expected: 0,
        },
        {
            description: 'apply to the setupAfterEnv fixture',
            file: 'packages/tests/src/_jest/setupAfterEnv.fixture.ts',
            expected: 1,
        },
        {
            description: 'apply to Jest fixtures',
            file: 'packages/plugins/example/src/a.fixture.ts',
            expected: 1,
        },
        {
            description: 'apply to Jest fixture modules',
            file: 'packages/plugins/example/src/a.fixtures.ts',
            expected: 1,
        },
        {
            description: 'apply to e2e helpers',
            file: 'packages/tests/src/e2e/a/helpers.ts',
            expected: 1,
        },
        {
            description: 'apply to plugin benchmark scripts',
            file: 'packages/plugins/live-debugger/scripts/benchmark-subset.js',
            expected: 1,
        },
        {
            description: 'apply to a Jest test next to the benchmark CLI scripts',
            file: 'packages/tests/src/bench/liveDebuggerRuntime/preflight.test.js',
            expected: 1,
        },
        {
            description: 'skip the benchmark build CLI script',
            file: 'packages/tests/src/bench/liveDebuggerRuntime/preflight-build.js',
            expected: 0,
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
