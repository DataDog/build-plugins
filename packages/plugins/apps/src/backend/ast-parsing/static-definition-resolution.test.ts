// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type * as eslintScope from 'eslint-scope';
import { parseAst } from 'rollup/parseAst';

import { createParsedModuleRecord, type ParsedModuleRecord } from './module-graph';
import {
    resolveStaticDefinitionForExport,
    resolveStaticDefinitionForVariable,
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

function getModuleVariable(record: ParsedModuleRecord, name: string): eslintScope.Variable {
    const variable = record.scopeAnalysis.moduleScope.set.get(name);
    if (!variable) {
        throw new Error(`Expected ${record.id} to declare ${name}`);
    }
    return variable;
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

describe('Backend Functions - static definition resolution', () => {
    test('Should resolve named import variables through source module exports', () => {
        const ids = createRecord(
            '/project/src/backend/ids.js',
            "export const HTTP_ID = 'conn-http';",
        );
        const actions = createRecord(
            '/project/src/backend/actions.backend.js',
            "import { HTTP_ID as ACTIVE_ID } from './ids.js';",
            [ids.id],
        );
        const modules = createModules([actions, ids]);

        const result = resolveStaticDefinitionForVariable(
            modules,
            actions.id,
            getModuleVariable(actions, 'ACTIVE_ID'),
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
        const modules = createModules([ids]);

        const result = resolveStaticDefinitionForExport(modules, ids.id, 'ACTIVE_HTTP_ID');

        expectLocalDefinition(result, ids.id, 'HTTP_ID');
        expect(result.hops).toMatchObject([
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
        const modules = createModules([index, ids]);

        const result = resolveStaticDefinitionForExport(modules, index.id, 'ACTIVE_HTTP_ID');

        expectLocalDefinition(result, ids.id, 'HTTP_ID');
        expect(result.hops).toMatchObject([
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
        const modules = createModules([relay, ids]);

        const result = resolveStaticDefinitionForExport(modules, relay.id, 'ACTIVE_HTTP_ID');

        expectLocalDefinition(result, ids.id, 'HTTP_ID');
        expect(result.hops).toMatchObject([
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
        const modules = createModules([index, ids]);

        const result = resolveStaticDefinitionForExport(modules, index.id, 'HTTP_ID');

        expectLocalDefinition(result, ids.id, 'HTTP_ID');
        expect(result.hops).toMatchObject([
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
        const modules = createModules([index, remoteIds]);

        const result = resolveStaticDefinitionForExport(modules, index.id, 'HTTP_ID');

        expectLocalDefinition(result, index.id, 'HTTP_ID');
        expect(result.hops).toMatchObject([
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
        const modules = createModules([index, one, two]);

        expect(resolveStaticDefinitionForExport(modules, index.id, 'HTTP_ID')).toMatchObject({
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
        const modules = createModules([index, ids]);

        expect(resolveStaticDefinitionForExport(modules, index.id, 'HTTP_ID')).toMatchObject({
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
        const modules = createModules([index]);

        expect(resolveStaticDefinitionForExport(modules, index.id, 'HTTP_ID')).toMatchObject({
            kind: 'unsupported',
            moduleId: '/project/src/backend/ids.js',
            reason: 'missing-module-record',
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
        const modules = createModules([one, two]);

        expect(resolveStaticDefinitionForExport(modules, one.id, 'HTTP_ID')).toMatchObject({
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
            `,
            [ids.id],
        );
        const modules = createModules([actions, ids]);

        expect(
            resolveStaticDefinitionForVariable(
                modules,
                actions.id,
                getModuleVariable(actions, 'DEFAULT_ID'),
            ),
        ).toMatchObject({
            kind: 'unsupported',
            moduleId: actions.id,
            reason: 'default-import',
            variableName: 'DEFAULT_ID',
        });
        expect(
            resolveStaticDefinitionForVariable(
                modules,
                actions.id,
                getModuleVariable(actions, 'namespaceIds'),
            ),
        ).toMatchObject({
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
        const modules = createModules([index, ids]);

        expect(resolveStaticDefinitionForExport(modules, index.id, 'HTTP_ID')).toMatchObject({
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
        const modules = createModules([ids]);

        expect(resolveStaticDefinitionForExport(modules, ids.id, 'MUTABLE_ID')).toMatchObject({
            kind: 'unsupported',
            moduleId: ids.id,
            reason: 'mutable-binding',
            variableName: 'MUTABLE_ID',
            detail: 'let',
        });
        expect(resolveStaticDefinitionForExport(modules, ids.id, 'getId')).toMatchObject({
            kind: 'unsupported',
            moduleId: ids.id,
            reason: 'unsupported-binding',
            variableName: 'getId',
            detail: 'FunctionDeclaration binding',
        });
    });
});
