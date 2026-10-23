// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { analyzeModuleScope } from '@dd/apps-plugin/backend/ast-parsing/module-scope';
import { NODE_REPLACEMENT_HINTS } from '@dd/apps-plugin/backend/ast-parsing/reject-globals-missing-from-node';
import { runBackendStaticChecks } from '@dd/apps-plugin/backend/ast-parsing/run-backend-static-checks';
import { ensureProgram } from '@dd/apps-plugin/backend/ast-parsing/type-guards';
import { resetEnvReadWarnings } from '@dd/apps-plugin/backend/ast-parsing/warn-env-reads';
import { NODE_BACKEND_RUNTIME } from '@dd/apps-plugin/constants';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import { parseAst } from 'rollup/parseAst';

const FILE_PATH = '/project/src/handler.backend.ts';

function check(code: string): void {
    const ast = parseAst(code);
    const program = ensureProgram(ast, FILE_PATH);
    const scopeAnalysis = analyzeModuleScope(program);
    const log = getMockLogger();
    runBackendStaticChecks(ast, FILE_PATH, log, scopeAnalysis);
}

describe('Backend Functions - runBackendStaticChecks', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        resetEnvReadWarnings();
    });

    test.each([
        {
            description: 'a Node built-in import',
            code: "import os from 'os';\nexport function run() { return os.hostname(); }",
        },
        {
            description: 'a node: built-in import',
            code: "import { readFile } from 'node:fs/promises';\nexport function run() { return readFile('/etc/hosts'); }",
        },
        {
            description: 'a dynamic Node built-in import',
            code: "export async function run() { const os = await import('os'); return os.hostname(); }",
        },
        {
            description: 'fetch',
            code: 'export function run() { return fetch("https://example.com"); }',
        },
        {
            description: 'globalThis.fetch',
            code: 'export function run() { return globalThis.fetch("https://example.com"); }',
        },
        {
            description: 'WebSocket',
            code: 'export function run() { return new WebSocket("wss://example.com"); }',
        },
        {
            description: 'copying every property of globalThis',
            code: 'export function run() { return { ...globalThis }; }',
        },
    ])(`should allow $description, which the ${NODE_BACKEND_RUNTIME} supports`, ({ code }) => {
        expect(() => check(code)).not.toThrow();
    });

    test.each([
        {
            name: 'XMLHttpRequest',
            code: 'export function run() { return new XMLHttpRequest(); }',
        },
        {
            name: 'EventSource',
            code: 'export function run() { return new EventSource("/events"); }',
        },
        {
            name: 'Deno',
            code: 'export function run() { return Deno.env.get("TOKEN"); }',
        },
    ])('should reject $name, which Node lacks, with a hint', ({ name, code }) => {
        expect(() => check(code)).toThrow(
            `"${name}" is not available in the ${NODE_BACKEND_RUNTIME}. ${NODE_REPLACEMENT_HINTS[name]}: ${FILE_PATH}`,
        );
    });

    test('should not warn about crypto or Intl', () => {
        check('export function run() { return [crypto.randomUUID(), new Intl.Locale("en")]; }');

        expect(mockLogFn).not.toHaveBeenCalled();
    });

    test('should warn about a process.env read', () => {
        check('export function run() { return process.env.STRIPE_KEY; }');

        const logged = mockLogFn.mock.calls.filter(([, level]) => level === 'warn');
        const messages = logged.map(([message]) => message);
        expect(messages).toEqual([expect.stringContaining('process.env.STRIPE_KEY')]);
    });
});
