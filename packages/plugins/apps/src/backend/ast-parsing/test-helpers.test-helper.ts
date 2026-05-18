// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Program } from 'estree';
import { parseAst } from 'rollup/parseAst';

import { createParsedModuleRecord, type ParsedModuleRecord } from './module-graph';

export const testBuildRoot = '/project';

export function parseTestProgram(code: string): Program {
    return parseAst(code) as Program;
}

export function createTestParsedModuleRecord(
    id: string,
    code: string,
    staticDependencies: string[] = [],
    buildRoot = testBuildRoot,
): ParsedModuleRecord {
    const record = createParsedModuleRecord(
        id,
        buildRoot,
        parseTestProgram(code),
        staticDependencies,
    );

    if (!record) {
        throw new Error(`Expected module record to be created for ${id}`);
    }
    return record;
}

export function createTestModuleMap(
    records: ParsedModuleRecord[],
): Map<string, ParsedModuleRecord> {
    return new Map(records.map((record) => [record.id, record]));
}
