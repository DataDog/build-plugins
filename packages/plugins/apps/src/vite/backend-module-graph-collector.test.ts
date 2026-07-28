// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { parseAst } from 'rollup/parseAst';

import { createBackendModuleGraphCollector } from './backend-module-graph-collector';

type FakeModuleInfo = { id: string; code: string | null };

/**
 * Calls the `moduleParsed` hook with a plugin context exposing `parse`, which is
 * where it takes its parser from. `rollup/parseAst` is what Rollup's real
 * context supplies. The hook reads only the few `ModuleInfo` fields these fakes
 * model, so building a complete one would be noise.
 */
const getModuleParsedHook = (collector: ReturnType<typeof createBackendModuleGraphCollector>) => {
    const hook = collector.plugin.moduleParsed;
    if (typeof hook !== 'function') {
        throw new Error('Expected "moduleParsed" to be a function hook.');
    }

    return (moduleInfo: object) => Reflect.apply(hook, { parse: parseAst }, [moduleInfo]);
};

const getEmit = (collector: ReturnType<typeof createBackendModuleGraphCollector>) => {
    const callHook = getModuleParsedHook(collector);

    return (moduleInfo: FakeModuleInfo, importedIds: string[] = []) => {
        const importedIdResolutions = importedIds.map((id) => ({ id }));
        callHook({ ...moduleInfo, importedIds, importedIdResolutions });
    };
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
        const callHook = getModuleParsedHook(collector);

        // Rolldown, Vite 8's default bundler, keeps `ast` on its Rollup-compat
        // object but stubs the getter to throw. Reading the property at all is
        // the failure, so it has to throw rather than be absent — which is also
        // why this is assembled in place instead of going through `getEmit`,
        // whose spread would trigger the getter during setup.
        const moduleInfo = {
            id: '/project/src/backend/actions.backend.ts',
            code: 'export const id = "conn-1";',
            importedIds: [],
            importedIdResolutions: [],
        };
        Object.defineProperty(moduleInfo, 'ast', {
            get() {
                throw new Error('UNSUPPORTED: ModuleInfo#ast');
            },
            enumerable: true,
        });

        callHook(moduleInfo);

        expect([...collector.getModuleRecords().keys()]).toEqual([
            '/project/src/backend/actions.backend.ts',
        ]);
    });
});
