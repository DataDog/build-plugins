// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Expression } from 'estree';

import type { ParsedModuleRecord } from './module-graph';
import {
    resolveStaticStringValue,
    type StaticStringValueResolution,
} from './static-string-resolution';
import { createTestModuleMap, createTestParsedModuleRecord } from './test-helpers.test-helper';

function getConstInitializer(record: ParsedModuleRecord, name: string): Expression {
    for (const node of record.ast.body) {
        const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
        if (declaration?.type !== 'VariableDeclaration') {
            continue;
        }

        for (const declarator of declaration.declarations) {
            if (declarator.id.type === 'Identifier' && declarator.id.name === name) {
                if (!declarator.init) {
                    throw new Error(`Expected ${name} to have an initializer`);
                }
                return declarator.init;
            }
        }
    }

    throw new Error(`Expected ${record.id} to declare ${name}`);
}

function expectResolvedString(
    result: StaticStringValueResolution,
    moduleId: string,
    value: string,
): void {
    expect(result).toEqual({
        kind: 'resolved',
        moduleId,
        value,
    });
}

function expectUnsupportedString(
    result: StaticStringValueResolution,
    expected: Record<string, unknown>,
): void {
    expect(result).toMatchObject({
        kind: 'unsupported',
        message: expect.any(String),
        ...expected,
    });
}

describe('Backend Functions - static string resolution', () => {
    test('Should resolve string literals', () => {
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            "const VALUE = 'conn-http';",
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectResolvedString(result, actions.id, 'conn-http');
    });

    test('Should resolve static template literals without interpolation', () => {
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            'const VALUE = `conn-http`;',
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectResolvedString(result, actions.id, 'conn-http');
    });

    test('Should return unsupported for dynamic template literals', () => {
        const interpolation = `${String.fromCharCode(36)}{prefix}`;
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            ["const prefix = 'conn';", `const VALUE = \`${interpolation}-http\`;`].join('\n'),
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectUnsupportedString(result, {
            moduleId: actions.id,
            reason: 'dynamic-template-literal',
        });
    });

    test('Should resolve same-module const strings and const chains', () => {
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            `
                const HTTP_ID = 'conn-http';
                const ACTIVE_ID = HTTP_ID;
                const VALUE = ACTIVE_ID;
            `,
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectResolvedString(result, actions.id, 'conn-http');
    });

    test('Should resolve imported string constants', () => {
        const ids = createTestParsedModuleRecord(
            '/project/src/backend/ids.js',
            "export const HTTP_ID = 'conn-http';",
        );
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { HTTP_ID } from './ids.js';
                const VALUE = HTTP_ID;
            `,
            [ids.id],
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions, ids]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectResolvedString(result, ids.id, 'conn-http');
    });

    test('Should resolve imported static template literals', () => {
        const ids = createTestParsedModuleRecord(
            '/project/src/backend/ids.js',
            'export const HTTP_ID = `conn-http`;',
        );
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { HTTP_ID } from './ids.js';
                const VALUE = HTTP_ID;
            `,
            [ids.id],
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions, ids]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectResolvedString(result, ids.id, 'conn-http');
    });

    test('Should resolve imported const chains in the definition module context', () => {
        const ids = createTestParsedModuleRecord(
            '/project/src/backend/ids.js',
            `
                const BASE_ID = 'conn-http';
                export const HTTP_ID = BASE_ID;
            `,
        );
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            `
                const BASE_ID = 'wrong-module';
                import { HTTP_ID } from './ids.js';
                const VALUE = HTTP_ID;
            `,
            [ids.id],
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions, ids]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectResolvedString(result, ids.id, 'conn-http');
    });

    test('Should resolve same-module object member reads', () => {
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            `
                const CONNECTIONS = { HTTP: 'conn-http' };
                const VALUE = CONNECTIONS.HTTP;
            `,
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectResolvedString(result, actions.id, 'conn-http');
    });

    test('Should resolve imported object member reads', () => {
        const ids = createTestParsedModuleRecord(
            '/project/src/backend/ids.js',
            `
                export const CONNECTIONS = {
                    HTTP: 'conn-http',
                };
            `,
        );
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { CONNECTIONS } from './ids.js';
                const VALUE = CONNECTIONS.HTTP;
            `,
            [ids.id],
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions, ids]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectResolvedString(result, ids.id, 'conn-http');
    });

    test('Should return unsupported for imported object member reads when the import is mutated', () => {
        const ids = createTestParsedModuleRecord(
            '/project/src/backend/ids.js',
            `
                export const CONNECTIONS = {
                    HTTP: 'conn-http',
                };
            `,
        );
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { CONNECTIONS } from './ids.js';
                CONNECTIONS.HTTP = 'conn-other';
                const VALUE = CONNECTIONS.HTTP;
            `,
            [ids.id],
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions, ids]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectUnsupportedString(result, {
            moduleId: ids.id,
            reason: 'imported-object-mutation',
            variableName: 'CONNECTIONS',
        });
    });

    test('Should return unsupported for imported object member reads when a local alias is mutated', () => {
        const ids = createTestParsedModuleRecord(
            '/project/src/backend/ids.js',
            `
                export const CONNECTIONS = {
                    HTTP: 'conn-http',
                };
            `,
        );
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { CONNECTIONS } from './ids.js';
                const ALIAS = CONNECTIONS;
                ALIAS.HTTP = 'conn-other';
                const VALUE = CONNECTIONS.HTTP;
            `,
            [ids.id],
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions, ids]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectUnsupportedString(result, {
            moduleId: ids.id,
            reason: 'imported-object-mutation',
            variableName: 'CONNECTIONS',
        });
    });

    test('Should resolve imported nested object member reads', () => {
        const ids = createTestParsedModuleRecord(
            '/project/src/backend/ids.js',
            `
                export const CONNECTIONS = {
                    HTTP: {
                        PROD: 'conn-http',
                    },
                };
            `,
        );
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { CONNECTIONS } from './ids.js';
                const VALUE = CONNECTIONS.HTTP.PROD;
            `,
            [ids.id],
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions, ids]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectResolvedString(result, ids.id, 'conn-http');
    });

    test('Should resolve object member values that reference const strings in the definition module', () => {
        const ids = createTestParsedModuleRecord(
            '/project/src/backend/ids.js',
            `
                const HTTP_ID = 'conn-http';
                export const CONNECTIONS = {
                    HTTP: HTTP_ID,
                };
            `,
        );
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            `
                const HTTP_ID = 'wrong-module';
                import { CONNECTIONS } from './ids.js';
                const VALUE = CONNECTIONS.HTTP;
            `,
            [ids.id],
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions, ids]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectResolvedString(result, ids.id, 'conn-http');
    });

    test('Should return unsupported for computed member reads', () => {
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            `
                const key = 'HTTP';
                const CONNECTIONS = { HTTP: 'conn-http' };
                const VALUE = CONNECTIONS[key];
            `,
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectUnsupportedString(result, {
            moduleId: actions.id,
            reason: 'computed-member-expression',
        });
    });

    test('Should return unsupported for dynamic object shapes', () => {
        const cases = [
            {
                code: `
                    const BASE = { HTTP: 'conn-http' };
                    const CONNECTIONS = { ...BASE };
                    const VALUE = CONNECTIONS.HTTP;
                `,
                reason: 'object-spread',
            },
            {
                code: `
                    const key = 'HTTP';
                    const CONNECTIONS = { [key]: 'conn-http' };
                    const VALUE = CONNECTIONS.HTTP;
                `,
                reason: 'computed-object-property',
            },
            {
                code: `
                    const CONNECTIONS = { get HTTP() { return 'conn-http'; } };
                    const VALUE = CONNECTIONS.HTTP;
                `,
                reason: 'accessor-object-property',
            },
            {
                code: `
                    const CONNECTIONS = { HTTP: 'conn-a', HTTP: 'conn-b' };
                    const VALUE = CONNECTIONS.HTTP;
                `,
                reason: 'duplicate-object-property',
            },
            {
                code: `
                    const CONNECTIONS = { SLACK: 'conn-slack' };
                    const VALUE = CONNECTIONS.HTTP;
                `,
                reason: 'missing-object-property',
            },
        ];

        for (const { code, reason } of cases) {
            const actions = createTestParsedModuleRecord(
                '/project/src/backend/actions.backend.js',
                code,
            );

            const result = resolveStaticStringValue(
                createTestModuleMap([actions]),
                actions.id,
                getConstInitializer(actions, 'VALUE'),
            );

            expectUnsupportedString(result, {
                moduleId: actions.id,
                reason,
            });
        }
    });

    test('Should return unsupported for member paths through non-object values', () => {
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            `
                const CONNECTIONS = { HTTP: 'conn-http' };
                const VALUE = CONNECTIONS.HTTP.PROD;
            `,
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectUnsupportedString(result, {
            moduleId: actions.id,
            reason: 'non-object-member-value',
            expressionType: 'Literal',
        });
    });

    test('Should return unsupported for static definition failures', () => {
        const ids = createTestParsedModuleRecord(
            '/project/src/backend/ids.js',
            "export let HTTP_ID = 'conn-http';",
        );
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { HTTP_ID } from './ids.js';
                const VALUE = HTTP_ID;
            `,
            [ids.id],
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions, ids]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectUnsupportedString(result, {
            moduleId: ids.id,
            reason: 'static-definition-unsupported',
            variableName: 'HTTP_ID',
            definition: {
                reason: 'mutable-binding',
                variableName: 'HTTP_ID',
            },
        });
    });

    test('Should return unsupported for const cycles', () => {
        const actions = createTestParsedModuleRecord(
            '/project/src/backend/actions.backend.js',
            `
                const A = B;
                const B = A;
                const VALUE = A;
            `,
        );

        const result = resolveStaticStringValue(
            createTestModuleMap([actions]),
            actions.id,
            getConstInitializer(actions, 'VALUE'),
        );

        expectUnsupportedString(result, {
            moduleId: actions.id,
            reason: 'cycle',
            variableName: 'A',
        });
    });
});
