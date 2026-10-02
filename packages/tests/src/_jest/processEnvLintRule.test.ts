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
            description: 'apply to Jest helpers',
            file: 'packages/tests/src/_jest/helpers/a.ts',
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
            description: 'skip the setupAfterEnv fixture, which copies it on purpose',
            file: 'packages/tests/src/_jest/setupAfterEnv.fixture.ts',
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
