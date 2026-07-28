// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parseAst } from 'rollup/parseAst';

import { createBackendModuleGraphCollector } from './backend-module-graph-collector';

type FakeModuleInfo = { id: string; code?: string | null };

/**
 * Invokes the hook with a plugin context exposing `parse`, which is where it gets
 * its parser. `rollup/parseAst` is what Rollup's real context uses.
 */
const getEmit = (collector: ReturnType<typeof createBackendModuleGraphCollector>) => {
    const moduleParsed = collector.plugin.moduleParsed as (
        this: { parse: typeof parseAst },
        moduleInfo: unknown,
    ) => void;

    // Fills the remaining fields in place rather than spreading into a new
    // object: a spread would drop (or trigger) an `ast` getter, and one case
    // below depends on that getter surviving intact.
    return (moduleInfo: FakeModuleInfo, importedIds: string[] = []) =>
        moduleParsed.call(
            { parse: parseAst },
            Object.assign(moduleInfo, {
                importedIds,
                importedIdResolutions: importedIds.map((id) => ({ id })),
            }),
        );
};

describe('Backend Functions - backend module graph collector', () => {
    test('Should collect parsed local module records from moduleParsed hooks', () => {
        const collector = createBackendModuleGraphCollector('/project');
        const emit = getEmit(collector);

        emit(
            {
                id: '/project/src/backend/actions.backend.js?import',
                code: `
                    import { getEcho } from './helpers/http.js';
                    export function run() {
                        return getEcho();
                    }
                `,
            },
            ['/project/src/backend/helpers/http.js?import'],
        );
        emit({ id: '/project/node_modules/package/index.js', code: 'export const value = true;' });
        emit({ id: '\0virtual-helper.js', code: 'export const value = true;' });
        emit({ id: 'virtual:dd-backend-dev:example.js', code: 'export const value = true;' });
        emit({ id: '/project/src/backend/external.js', code: null });

        expect([...collector.getModuleRecords().keys()]).toEqual([
            '/project/src/backend/actions.backend.js',
        ]);
        expect(
            collector.getModuleRecords().get('/project/src/backend/actions.backend.js'),
        ).toMatchObject({
            staticDependencies: [
                {
                    source: './helpers/http.js',
                    resolvedId: '/project/src/backend/helpers/http.js',
                },
            ],
        });
    });

    test('Should collect records under a bundler that does not support ModuleInfo#ast', () => {
        const collector = createBackendModuleGraphCollector('/project');
        const emit = getEmit(collector);

        // Rolldown, the bundler Vite 8 uses by default, keeps `ast` on its
        // Rollup-compat object but stubs the getter to throw. Reading the
        // property at all is the failure, so it must throw rather than be absent.
        const moduleInfo: FakeModuleInfo = Object.defineProperty(
            { id: '/project/src/backend/actions.backend.ts', code: 'export const id = "conn-1";' },
            'ast',
            {
                get() {
                    throw new Error('UNSUPPORTED: ModuleInfo#ast');
                },
                enumerable: true,
            },
        );

        expect(() => emit(moduleInfo)).not.toThrow();
        expect([...collector.getModuleRecords().keys()]).toEqual([
            '/project/src/backend/actions.backend.ts',
        ]);
    });
});
