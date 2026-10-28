// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createParsedModuleRecord } from '@dd/apps-plugin/backend/ast-parsing/module-graph';
import { NODE_BACKEND_RUNTIME } from '@dd/apps-plugin/constants';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import { parseAst } from 'rollup/parseAst';

import { createBackendStaticChecksPlugin } from './backend-static-checks-plugin';

type FakeModuleInfo = { id: string; code: string | null };

// `parse` defaults to `rollup/parseAst` (matching Rollup's real context); a test asserting no re-parse passes one that throws instead.
function callModuleParsed(
    plugin: ReturnType<typeof createBackendStaticChecksPlugin>,
    moduleInfo: FakeModuleInfo,
    parse: typeof parseAst = parseAst,
): void {
    const hook = plugin.moduleParsed;
    if (typeof hook !== 'function') {
        throw new Error('Expected "moduleParsed" to be a function hook.');
    }

    Reflect.apply(hook, { parse }, [moduleInfo]);
}

describe('Backend Functions - backend static checks plugin', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('Should accept a module importing a Node built-in and calling fetch', () => {
        const plugin = createBackendStaticChecksPlugin(
            '/project',
            getMockLogger(),
            () => new Map(),
        );

        expect(() =>
            callModuleParsed(plugin, {
                id: '/project/src/backend/helpers/http.js',
                code: "import fs from 'fs';\nexport function readIt() { fs.readFileSync('/etc/hosts'); return fetch('https://example.com'); }",
            }),
        ).not.toThrow();
    });

    test('Should reject a module using Deno', () => {
        const plugin = createBackendStaticChecksPlugin(
            '/project',
            getMockLogger(),
            () => new Map(),
        );

        expect(() =>
            callModuleParsed(plugin, {
                id: '/project/src/backend/helpers/http.js',
                code: 'export function cwd() { return Deno.cwd(); }',
            }),
        ).toThrow(`"Deno" is not available in the ${NODE_BACKEND_RUNTIME}`);
    });

    test('Should allow a module with no restricted globals', () => {
        const plugin = createBackendStaticChecksPlugin(
            '/project',
            getMockLogger(),
            () => new Map(),
        );

        expect(() =>
            callModuleParsed(plugin, {
                id: '/project/src/backend/helpers/http.js',
                code: 'export function add(a, b) { return a + b; }',
            }),
        ).not.toThrow();
    });

    test('Should skip modules under node_modules', () => {
        const plugin = createBackendStaticChecksPlugin(
            '/project',
            getMockLogger(),
            () => new Map(),
        );

        expect(() =>
            callModuleParsed(plugin, {
                id: '/project/node_modules/some-package/index.js',
                code: "import fs from 'fs';\nexport const value = fs;",
            }),
        ).not.toThrow();
    });

    test('Should skip virtual modules', () => {
        const plugin = createBackendStaticChecksPlugin(
            '/project',
            getMockLogger(),
            () => new Map(),
        );

        expect(() =>
            callModuleParsed(plugin, {
                id: '\0dd-backend:hash.greet',
                code: "import fs from 'fs';\nexport const value = fs;",
            }),
        ).not.toThrow();
        expect(() =>
            callModuleParsed(plugin, {
                id: 'virtual:dd-backend-dev:greet.js',
                code: "import fs from 'fs';\nexport const value = fs;",
            }),
        ).not.toThrow();
    });

    test('Should skip modules with no source (external/synthetic modules)', () => {
        const plugin = createBackendStaticChecksPlugin(
            '/project',
            getMockLogger(),
            () => new Map(),
        );

        expect(() =>
            callModuleParsed(plugin, {
                id: '/project/src/backend/external.js',
                code: null,
            }),
        ).not.toThrow();
    });

    test('Should reuse an already-parsed module record instead of re-parsing', () => {
        const moduleId = '/project/src/backend/helpers/http.js';
        const ast = parseAst('export function callIt() { return Deno.cwd(); }');
        const record = createParsedModuleRecord(moduleId, '/project', ast, []);
        if (!record) {
            throw new Error('Expected a module record to be created for this test.');
        }
        const plugin = createBackendStaticChecksPlugin(
            '/project',
            getMockLogger(),
            () => new Map([[moduleId, record]]),
        );
        const throwIfParsed: typeof parseAst = () => {
            throw new Error('Should not re-parse a module that already has a record.');
        };

        expect(() =>
            callModuleParsed(
                plugin,
                { id: moduleId, code: 'this code is never read when a record already exists' },
                throwIfParsed,
            ),
        ).toThrow(`"Deno" is not available in the ${NODE_BACKEND_RUNTIME}`);
    });

    test('Should fall back to parsing when no record exists for the module', () => {
        const plugin = createBackendStaticChecksPlugin(
            '/project',
            getMockLogger(),
            () => new Map(),
        );

        expect(() =>
            callModuleParsed(plugin, {
                id: '/project/src/backend/helpers/http.js',
                code: 'export function callIt() { return Deno.cwd(); }',
            }),
        ).toThrow(`"Deno" is not available in the ${NODE_BACKEND_RUNTIME}`);
    });

    test('Should throw a checks-specific error, not a connection-ID-collector-specific one, when the fallback parse fails', () => {
        const plugin = createBackendStaticChecksPlugin(
            '/project',
            getMockLogger(),
            () => new Map(),
        );

        expect(() =>
            callModuleParsed(plugin, {
                id: '/project/src/backend/helpers/broken.js',
                code: 'export function callIt( {',
            }),
        ).toThrow(
            /Unsupported module source .*: unparseable module source .* could hide a restricted-global access/,
        );
    });
});
