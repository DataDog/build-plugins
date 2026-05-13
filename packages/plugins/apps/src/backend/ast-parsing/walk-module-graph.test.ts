// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parseAst } from 'rollup/parseAst';

import type { ModuleDependency, ParsedModuleRecord, StaticModuleDependency } from './module-graph';
import { ensureProgram } from './type-guards';
import { walkModuleGraph } from './walk-module-graph';

const buildRoot = '/project';

function createRecord(
    id: string,
    staticDependencies: string[] = [],
    unsupportedDependencies: ModuleDependency[] = [],
): ParsedModuleRecord {
    return {
        id,
        ast: ensureProgram(parseAst('export const value = true;'), id),
        staticDependencies: staticDependencies.map(toStaticDependency),
        unsupportedDependencies,
    };
}

function toStaticDependency(resolvedId: string): StaticModuleDependency {
    return { source: resolvedId, resolvedId };
}

describe('Backend Functions - module graph walk', () => {
    test('Should visit each reachable local module once', () => {
        const modules = new Map<string, ParsedModuleRecord>([
            [
                '/project/src/backend/actions.backend.ts',
                createRecord('/project/src/backend/actions.backend.ts', [
                    '/project/src/backend/helper.ts',
                ]),
            ],
            [
                '/project/src/backend/helper.ts',
                createRecord('/project/src/backend/helper.ts', ['/project/src/backend/shared.ts']),
            ],
            [
                '/project/src/backend/shared.ts',
                createRecord('/project/src/backend/shared.ts', ['/project/src/backend/helper.ts']),
            ],
        ]);
        const visited: string[] = [];

        walkModuleGraph(
            '/project/src/backend/actions.backend.ts',
            modules,
            buildRoot,
            (context) => {
                visited.push(context.moduleId);
            },
        );

        expect(visited).toEqual([
            '/project/src/backend/actions.backend.ts',
            '/project/src/backend/helper.ts',
            '/project/src/backend/shared.ts',
        ]);
    });

    test('Should skip dependencies outside the app-local parseable graph', () => {
        const modules = new Map<string, ParsedModuleRecord>([
            [
                '/project/src/backend/actions.backend.ts',
                createRecord('/project/src/backend/actions.backend.ts', [
                    '/project/src/backend/helper.ts',
                    '/project/node_modules/package/index.js',
                    '/project/src/backend/data.json',
                    '/external/helper.ts',
                ]),
            ],
            ['/project/src/backend/helper.ts', createRecord('/project/src/backend/helper.ts')],
        ]);
        const visited: string[] = [];

        walkModuleGraph(
            '/project/src/backend/actions.backend.ts',
            modules,
            buildRoot,
            (context) => {
                visited.push(context.moduleId);
            },
        );

        expect(visited).toEqual([
            '/project/src/backend/actions.backend.ts',
            '/project/src/backend/helper.ts',
        ]);
    });

    test('Should fail closed when the entry record is missing', () => {
        expect(() => {
            walkModuleGraph(
                '/project/src/backend/actions.backend.ts',
                new Map(),
                buildRoot,
                () => {},
            );
        }).toThrow(
            'Unsupported local module graph for /project/src/backend/actions.backend.ts: missing module record for /project/src/backend/actions.backend.ts could hide an action-catalog connectionId.',
        );
    });

    test('Should fail closed when a reachable local dependency was not collected', () => {
        const modules = new Map<string, ParsedModuleRecord>([
            [
                '/project/src/backend/actions.backend.ts',
                createRecord('/project/src/backend/actions.backend.ts', [
                    '/project/src/backend/helper.ts',
                ]),
            ],
        ]);

        expect(() => {
            walkModuleGraph(
                '/project/src/backend/actions.backend.ts',
                modules,
                buildRoot,
                () => {},
            );
        }).toThrow(
            'Unsupported local module graph for /project/src/backend/actions.backend.ts: uncollected local import /project/src/backend/helper.ts from /project/src/backend/actions.backend.ts could hide an action-catalog connectionId.',
        );
    });

    test('Should fail closed for unsupported reachable local dependencies', () => {
        const modules = new Map<string, ParsedModuleRecord>([
            [
                '/project/src/backend/actions.backend.ts',
                createRecord(
                    '/project/src/backend/actions.backend.ts',
                    [],
                    [{ kind: 'dynamic-import', specifier: './helper' }],
                ),
            ],
        ]);

        expect(() => {
            walkModuleGraph(
                '/project/src/backend/actions.backend.ts',
                modules,
                buildRoot,
                () => {},
            );
        }).toThrow(
            'Unsupported local module graph for /project/src/backend/actions.backend.ts: dynamic-import ./helper could hide an action-catalog connectionId.',
        );
    });
});
