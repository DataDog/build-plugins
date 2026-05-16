// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Identifier } from 'estree';
import { parseAst } from 'rollup/parseAst';

import { createParsedModuleRecord, type ParsedModuleRecord } from './module-graph';
import {
    resolveStaticDefinitionForIdentifier,
    type StaticDefinition,
} from './static-definition-resolution';

const buildRoot = '/project';

function createRecord(
    id: string,
    code: string,
    staticDependencies: string[] = [],
): ParsedModuleRecord {
    const record = createParsedModuleRecord(id, buildRoot, parseAst(code), staticDependencies);

    if (!record) {
        throw new Error(`Expected module record to be created for ${id}`);
    }
    return record;
}

function createModules(records: ParsedModuleRecord[]): Map<string, ParsedModuleRecord> {
    return new Map(records.map((record) => [record.id, record]));
}

function getReferenceIdentifier(record: ParsedModuleRecord, name: string): Identifier {
    for (const [identifier, reference] of record.scopeAnalysis.referencesByIdentifier) {
        const isDefinitionIdentifier = reference.resolved?.defs.some(
            (definition) => definition.name === identifier,
        );
        if (identifier.name === name && !isDefinitionIdentifier) {
            return identifier;
        }
    }

    throw new Error(`Expected ${record.id} to reference ${name}`);
}

function getDeclarationIdentifier(record: ParsedModuleRecord, name: string): Identifier {
    for (const node of record.ast.body) {
        const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
        if (declaration?.type !== 'VariableDeclaration') {
            continue;
        }

        for (const declarator of declaration.declarations) {
            if (declarator.id.type === 'Identifier' && declarator.id.name === name) {
                return declarator.id;
            }
        }
    }

    throw new Error(`Expected ${record.id} to declare ${name}`);
}

function expectLocalDefinition(
    result: StaticDefinition,
    moduleId: string,
    variableName: string,
): void {
    expect(result).toMatchObject({
        kind: 'local',
        moduleId,
        variable: { name: variableName },
        binding: { kind: 'const' },
    });
}

function expectUnsupportedDefinition(
    result: StaticDefinition,
    expected: Record<string, unknown>,
): void {
    expect(result).toMatchObject({
        kind: 'unsupported',
        message: expect.any(String),
        ...expected,
    });
}

describe('Backend Functions - static definition resolution', () => {
    test('Should resolve same-module identifier references to top-level static bindings', () => {
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            `
                const HTTP_ID = 'conn-http';
                request({ connectionId: HTTP_ID });
            `,
        );
        const modules = createModules([actions]);

        const result = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'HTTP_ID'),
        );

        expectLocalDefinition(result, actions.id, 'HTTP_ID');
        expect(result.hops).toEqual([]);
    });

    test('Should resolve named import identifiers through source module exports', () => {
        const ids = createRecord(
            '/project/src/backend/ids.js',
            "export const HTTP_ID = 'conn-http';",
        );
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { HTTP_ID as ACTIVE_ID } from './ids.js';
                request({ connectionId: ACTIVE_ID });
            `,
            [ids.id],
        );
        const modules = createModules([actions, ids]);

        const result = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'ACTIVE_ID'),
        );

        expectLocalDefinition(result, ids.id, 'HTTP_ID');
        expect(result.hops).toMatchObject([
            { kind: 'import', moduleId: actions.id, localName: 'ACTIVE_ID' },
            { kind: 'local-export', moduleId: ids.id, exportName: 'HTTP_ID' },
        ]);
    });

    test('Should resolve local export aliases to top-level static bindings', () => {
        const ids = createRecord(
            '/project/src/backend/ids.js',
            `
                const HTTP_ID = 'conn-http';
                export { HTTP_ID as ACTIVE_HTTP_ID };
            `,
        );
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { ACTIVE_HTTP_ID } from './ids.js';
                request({ connectionId: ACTIVE_HTTP_ID });
            `,
            [ids.id],
        );
        const modules = createModules([actions, ids]);

        const result = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'ACTIVE_HTTP_ID'),
        );

        expectLocalDefinition(result, ids.id, 'HTTP_ID');
        expect(result.hops).toMatchObject([
            { kind: 'import', moduleId: actions.id, localName: 'ACTIVE_HTTP_ID' },
            { kind: 'local-export', moduleId: ids.id, exportName: 'ACTIVE_HTTP_ID' },
        ]);
    });

    test('Should resolve named re-export aliases', () => {
        const ids = createRecord(
            '/project/src/backend/ids.js',
            "export const HTTP_ID = 'conn-http';",
        );
        const index = createRecord(
            '/project/src/backend/index.js',
            "export { HTTP_ID as ACTIVE_HTTP_ID } from './ids.js';",
            [ids.id],
        );
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { ACTIVE_HTTP_ID } from './index.js';
                request({ connectionId: ACTIVE_HTTP_ID });
            `,
            [index.id],
        );
        const modules = createModules([actions, index, ids]);

        const result = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'ACTIVE_HTTP_ID'),
        );

        expectLocalDefinition(result, ids.id, 'HTTP_ID');
        expect(result.hops).toMatchObject([
            { kind: 'import', moduleId: actions.id, localName: 'ACTIVE_HTTP_ID' },
            { kind: 're-export', moduleId: index.id, exportName: 'ACTIVE_HTTP_ID' },
            { kind: 'local-export', moduleId: ids.id, exportName: 'HTTP_ID' },
        ]);
    });

    test('Should resolve local import and export relays', () => {
        const ids = createRecord(
            '/project/src/backend/ids.js',
            "export const HTTP_ID = 'conn-http';",
        );
        const relay = createRecord(
            '/project/src/backend/relay.js',
            `
                import { HTTP_ID } from './ids.js';
                export { HTTP_ID as ACTIVE_HTTP_ID };
            `,
            [ids.id],
        );
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { ACTIVE_HTTP_ID } from './relay.js';
                request({ connectionId: ACTIVE_HTTP_ID });
            `,
            [relay.id],
        );
        const modules = createModules([actions, relay, ids]);

        const result = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'ACTIVE_HTTP_ID'),
        );

        expectLocalDefinition(result, ids.id, 'HTTP_ID');
        expect(result.hops).toMatchObject([
            { kind: 'import', moduleId: actions.id, localName: 'ACTIVE_HTTP_ID' },
            { kind: 'local-export', moduleId: relay.id, exportName: 'ACTIVE_HTTP_ID' },
            { kind: 'import', moduleId: relay.id, localName: 'HTTP_ID' },
            { kind: 'local-export', moduleId: ids.id, exportName: 'HTTP_ID' },
        ]);
    });

    test('Should resolve unambiguous star exports', () => {
        const ids = createRecord(
            '/project/src/backend/ids.js',
            "export const HTTP_ID = 'conn-http';",
        );
        const index = createRecord('/project/src/backend/index.js', "export * from './ids.js';", [
            ids.id,
        ]);
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { HTTP_ID } from './index.js';
                request({ connectionId: HTTP_ID });
            `,
            [index.id],
        );
        const modules = createModules([actions, index, ids]);

        const result = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'HTTP_ID'),
        );

        expectLocalDefinition(result, ids.id, 'HTTP_ID');
        expect(result.hops).toMatchObject([
            { kind: 'import', moduleId: actions.id, localName: 'HTTP_ID' },
            { kind: 'star-export', moduleId: index.id, exportName: 'HTTP_ID' },
            { kind: 'local-export', moduleId: ids.id, exportName: 'HTTP_ID' },
        ]);
    });

    test('Should ignore duplicate star export paths to the same binding', () => {
        const ids = createRecord(
            '/project/src/backend/ids.js',
            "export const HTTP_ID = 'conn-http';",
        );
        const nested = createRecord('/project/src/backend/nested.js', "export * from './ids.js';", [
            ids.id,
        ]);
        const index = createRecord(
            '/project/src/backend/index.js',
            `
                export * from './ids.js';
                export * from './nested.js';
            `,
            [ids.id, nested.id],
        );
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { HTTP_ID } from './index.js';
                request({ connectionId: HTTP_ID });
            `,
            [index.id],
        );
        const modules = createModules([actions, index, nested, ids]);

        const result = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'HTTP_ID'),
        );

        expectLocalDefinition(result, ids.id, 'HTTP_ID');
        expect(result.hops).toMatchObject([
            { kind: 'import', moduleId: actions.id, localName: 'HTTP_ID' },
            { kind: 'star-export', moduleId: index.id, exportName: 'HTTP_ID' },
            { kind: 'local-export', moduleId: ids.id, exportName: 'HTTP_ID' },
        ]);
    });

    test('Should prefer explicit exports over star exports', () => {
        const remoteIds = createRecord(
            '/project/src/backend/remote-ids.js',
            "export const HTTP_ID = 'conn-remote';",
        );
        const index = createRecord(
            '/project/src/backend/index.js',
            `
                export const HTTP_ID = 'conn-local';
                export * from './remote-ids.js';
            `,
            [remoteIds.id],
        );
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { HTTP_ID } from './index.js';
                request({ connectionId: HTTP_ID });
            `,
            [index.id],
        );
        const modules = createModules([actions, index, remoteIds]);

        const result = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'HTTP_ID'),
        );

        expectLocalDefinition(result, index.id, 'HTTP_ID');
        expect(result.hops).toMatchObject([
            { kind: 'import', moduleId: actions.id, localName: 'HTTP_ID' },
            { kind: 'local-export', moduleId: index.id, exportName: 'HTTP_ID' },
        ]);
    });

    test('Should return unsupported for ambiguous star exports', () => {
        const one = createRecord('/project/src/backend/one.js', "export const HTTP_ID = 'one';");
        const two = createRecord('/project/src/backend/two.js', "export const HTTP_ID = 'two';");
        const index = createRecord(
            '/project/src/backend/index.js',
            `
                export * from './one.js';
                export * from './two.js';
            `,
            [one.id, two.id],
        );
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { HTTP_ID } from './index.js';
                request({ connectionId: HTTP_ID });
            `,
            [index.id],
        );
        const modules = createModules([actions, index, one, two]);

        const result = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'HTTP_ID'),
        );

        expectUnsupportedDefinition(result, {
            kind: 'unsupported',
            moduleId: index.id,
            reason: 'ambiguous-star-export',
            exportName: 'HTTP_ID',
        });
    });

    test('Should return unsupported for missing exports', () => {
        const ids = createRecord('/project/src/backend/ids.js', "export const OTHER_ID = 'other';");
        const index = createRecord('/project/src/backend/index.js', "export * from './ids.js';", [
            ids.id,
        ]);
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { HTTP_ID } from './index.js';
                request({ connectionId: HTTP_ID });
            `,
            [index.id],
        );
        const modules = createModules([actions, index, ids]);

        const result = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'HTTP_ID'),
        );

        expectUnsupportedDefinition(result, {
            kind: 'unsupported',
            moduleId: index.id,
            reason: 'missing-export',
            exportName: 'HTTP_ID',
        });
    });

    test('Should return unsupported for missing module records', () => {
        const index = createRecord(
            '/project/src/backend/index.js',
            "export { HTTP_ID } from './ids.js';",
            ['/project/src/backend/ids.js'],
        );
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { HTTP_ID } from './index.js';
                request({ connectionId: HTTP_ID });
            `,
            [index.id],
        );
        const modules = createModules([actions, index]);

        const result = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'HTTP_ID'),
        );

        expectUnsupportedDefinition(result, {
            kind: 'unsupported',
            moduleId: '/project/src/backend/ids.js',
            reason: 'missing-module-record',
            requestKind: 'export',
            exportName: 'HTTP_ID',
        });
    });

    test('Should return unsupported for import and export cycles', () => {
        const one = createRecord('/project/src/backend/one.js', "export * from './two.js';", [
            '/project/src/backend/two.js',
        ]);
        const two = createRecord('/project/src/backend/two.js', "export * from './one.js';", [
            one.id,
        ]);
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { HTTP_ID } from './one.js';
                request({ connectionId: HTTP_ID });
            `,
            [one.id],
        );
        const modules = createModules([actions, one, two]);

        const result = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'HTTP_ID'),
        );

        expectUnsupportedDefinition(result, {
            kind: 'unsupported',
            moduleId: one.id,
            reason: 'cycle',
            exportName: 'HTTP_ID',
        });
    });

    test('Should return unsupported for default and namespace imports', () => {
        const ids = createRecord(
            '/project/src/backend/ids.js',
            "export const HTTP_ID = 'conn-http';",
        );
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            `
                import DEFAULT_ID from './ids.js';
                import * as namespaceIds from './ids.js';
                request({ connectionId: DEFAULT_ID });
                request({ connectionId: namespaceIds.HTTP_ID });
            `,
            [ids.id],
        );
        const modules = createModules([actions, ids]);

        const defaultImportResult = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'DEFAULT_ID'),
        );

        expectUnsupportedDefinition(defaultImportResult, {
            kind: 'unsupported',
            moduleId: actions.id,
            reason: 'default-import',
            variableName: 'DEFAULT_ID',
        });
        const namespaceImportResult = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'namespaceIds'),
        );

        expectUnsupportedDefinition(namespaceImportResult, {
            kind: 'unsupported',
            moduleId: actions.id,
            reason: 'namespace-import',
            variableName: 'namespaceIds',
        });
    });

    test('Should return unsupported for default re-exports', () => {
        const ids = createRecord('/project/src/backend/ids.js', "export default 'conn-http';");
        const index = createRecord(
            '/project/src/backend/index.js',
            "export { default as HTTP_ID } from './ids.js';",
            [ids.id],
        );
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { HTTP_ID } from './index.js';
                request({ connectionId: HTTP_ID });
            `,
            [index.id],
        );
        const modules = createModules([actions, index, ids]);

        const result = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'HTTP_ID'),
        );

        expectUnsupportedDefinition(result, {
            kind: 'unsupported',
            moduleId: index.id,
            reason: 'default-export',
            exportName: 'HTTP_ID',
        });
    });

    test('Should return unsupported for mutable and otherwise unsupported bindings', () => {
        const ids = createRecord(
            '/project/src/backend/ids.js',
            `
                export let MUTABLE_ID = 'conn-mutable';
                export function getId() {
                    return 'conn-function';
                }
            `,
        );
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            `
                import { MUTABLE_ID, getId } from './ids.js';
                request({ connectionId: MUTABLE_ID });
                request({ connectionId: getId });
            `,
            [ids.id],
        );
        const modules = createModules([actions, ids]);

        const mutableResult = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'MUTABLE_ID'),
        );

        expectUnsupportedDefinition(mutableResult, {
            kind: 'unsupported',
            moduleId: ids.id,
            reason: 'mutable-binding',
            variableName: 'MUTABLE_ID',
            declarationKind: 'let',
        });
        const unsupportedBindingResult = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getReferenceIdentifier(actions, 'getId'),
        );

        expectUnsupportedDefinition(unsupportedBindingResult, {
            kind: 'unsupported',
            moduleId: ids.id,
            reason: 'unsupported-binding',
            variableName: 'getId',
            bindingReason: 'FunctionDeclaration binding',
        });
    });

    test('Should return unsupported for identifiers that are not references', () => {
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            "const HTTP_ID = 'conn-http';",
        );
        const modules = createModules([actions]);

        const result = resolveStaticDefinitionForIdentifier(
            modules,
            actions.id,
            getDeclarationIdentifier(actions, 'HTTP_ID'),
        );

        expectUnsupportedDefinition(result, {
            kind: 'unsupported',
            moduleId: actions.id,
            reason: 'unresolved-identifier',
            variableName: 'HTTP_ID',
        });
    });
});
