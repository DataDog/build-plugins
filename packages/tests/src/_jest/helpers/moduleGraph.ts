// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import {
    createParsedModuleRecord,
    getStaticModuleSources,
    type ParsedModuleRecord,
    type StaticModuleDependency,
} from '@dd/apps-plugin/backend/ast-parsing/module-graph';
import { ensureProgram } from '@dd/apps-plugin/backend/ast-parsing/type-guards';
import type { BaseNode } from 'estree';
import { parseAst } from 'rollup/parseAst';

// Module-graph fixtures list one resolved ID per static import/export statement,
// in source order; a repeated source must repeat the same ID.
export const pairStaticDependencies = (
    ast: BaseNode,
    resolvedIds: string[],
): StaticModuleDependency[] => {
    const program = ensureProgram(ast, 'fixture');
    const sources = getStaticModuleSources(program);
    if (sources.length !== resolvedIds.length) {
        throw new Error(
            `Fixture lists ${resolvedIds.length} resolved IDs for ${sources.length} static sources.`,
        );
    }
    const resolvedIdBySource = new Map<string, string>();
    sources.forEach((source, index) => {
        const resolvedId = resolvedIds[index];
        const earlierId = resolvedIdBySource.get(source);
        if (earlierId !== undefined && earlierId !== resolvedId) {
            throw new Error(`Fixture gives "${source}" both ${earlierId} and ${resolvedId}.`);
        }
        resolvedIdBySource.set(source, resolvedId);
    });
    return [...resolvedIdBySource].map(([source, resolvedId]) => ({ source, resolvedId }));
};

// Parses `code` and builds its module record, pairing `resolvedIds` per statement.
export const createFixtureRecord = (
    id: string,
    buildRoot: string,
    code: string,
    resolvedIds: string[],
): ParsedModuleRecord => {
    const ast = parseAst(code);
    const staticDependencies = pairStaticDependencies(ast, resolvedIds);
    const record = createParsedModuleRecord(id, buildRoot, ast, staticDependencies);
    if (!record) {
        throw new Error(`Expected ${id} to create a parsed module record`);
    }
    return record;
};
