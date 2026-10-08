// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BackendRuntime } from '@dd/apps-plugin/backend-runtime';
import { analyzeModuleScope } from '@dd/apps-plugin/backend/ast-parsing/module-scope';
import { runBackendStaticChecks } from '@dd/apps-plugin/backend/ast-parsing/run-backend-static-checks';
import { ensureProgram } from '@dd/apps-plugin/backend/ast-parsing/type-guards';
import { resetDivergentGlobalWarnings } from '@dd/apps-plugin/backend/ast-parsing/warn-divergent-globals';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import { parseAst } from 'rollup/parseAst';

const FILE_PATH = '/project/src/handler.backend.ts';

const NODE_BUILTIN_IMPORT = "import os from 'os';\nexport function run() { return os.hostname(); }";
const NETWORK_GLOBAL = 'export function run() { return fetch("https://example.com"); }';
const DIVERGENT_GLOBAL = 'export function run() { return crypto.randomUUID(); }';

function check(code: string, runtime: BackendRuntime): void {
    const ast = parseAst(code);
    const program = ensureProgram(ast, FILE_PATH);
    const scopeAnalysis = analyzeModuleScope(program);
    const log = getMockLogger();
    runBackendStaticChecks(ast, FILE_PATH, log, scopeAnalysis, runtime);
}

describe('Backend Functions - runBackendStaticChecks', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        resetDivergentGlobalWarnings();
    });

    test.each([
        {
            description: 'a Node built-in import',
            code: NODE_BUILTIN_IMPORT,
            error: 'Importing Node built-in module "os" is not supported',
        },
        {
            description: 'a network global',
            code: NETWORK_GLOBAL,
            error: 'Using "fetch" is not supported',
        },
    ])('should reject $description under v1', ({ code, error }) => {
        expect(() => check(code, 'v1')).toThrow(error);
    });

    test.each([
        { description: 'a Node built-in import', code: NODE_BUILTIN_IMPORT },
        { description: 'a network global', code: NETWORK_GLOBAL },
    ])('should allow $description under v2', ({ code }) => {
        expect(() => check(code, 'v2')).not.toThrow();
    });

    test.each([
        { name: 'XMLHttpRequest', code: 'export function run() { return new XMLHttpRequest(); }' },
        {
            name: 'EventSource',
            code: 'export function run() { return new EventSource("/events"); }',
        },
    ])('should reject $name under v2, since Node has no such global', ({ name, code }) => {
        expect(() => check(code, 'v2')).toThrow(`"${name}" is not available`);
    });

    test('should run the v1 checks for a runtime it does not recognize', () => {
        const ast = parseAst(NETWORK_GLOBAL);
        const program = ensureProgram(ast, FILE_PATH);
        const scopeAnalysis = analyzeModuleScope(program);
        const args = [ast, FILE_PATH, getMockLogger(), scopeAnalysis, 'v3'];

        expect(() => Reflect.apply(runBackendStaticChecks, undefined, args)).toThrow(
            'Using "fetch" is not supported',
        );
    });

    const divergentGlobalCases: Array<{ runtime: BackendRuntime; warns: boolean }> = [
        { runtime: 'v1', warns: true },
        { runtime: 'v2', warns: false },
    ];
    test.each(divergentGlobalCases)(
        'should warn about divergent globals only under v1 ($runtime)',
        ({ runtime, warns }) => {
            check(DIVERGENT_GLOBAL, runtime);

            const warnings = mockLogFn.mock.calls.filter(([, level]) => level === 'warn');
            expect(warnings.length > 0).toBe(warns);
        },
    );
});
