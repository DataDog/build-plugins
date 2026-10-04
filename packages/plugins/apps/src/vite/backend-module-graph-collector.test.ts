// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { resolveFixtureSpecifier } from '@dd/tests/_jest/helpers/moduleParsed';
import { parseAst } from 'rollup/parseAst';
import { rollup } from 'rollup';

import { createBackendModuleGraphCollector } from './backend-module-graph-collector';

type FakeModuleInfo = { id: string; code: string | null };
type Resolutions = Record<string, string | null>;

/**
 * Calls the `moduleParsed` hook with a plugin context exposing `parse` and
 * `resolve`, which is where it takes its parser and resolver from.
 * `rollup/parseAst` is what Rollup's real context supplies. The hook reads only
 * the few `ModuleInfo` fields these fakes model, so building a complete one
 * would be noise.
 */
const getModuleParsedHook = (
    collector: ReturnType<typeof createBackendModuleGraphCollector>,
    resolutions: Resolutions = {},
) => {
    const hook = collector.plugin.moduleParsed;
    if (typeof hook !== 'object' || !hook || typeof hook.handler !== 'function') {
        throw new Error('Expected "moduleParsed" to be an object hook with a handler.');
    }
    const handler = hook.handler;

    const parse = jest.fn(parseAst);
    const resolve = jest.fn(async (source: string) => {
        const id = resolutions[source];
        return id ? { id, external: false } : null;
    });
    const callHook = async (moduleInfo: object) => {
        await Reflect.apply(handler, { parse, resolve }, [moduleInfo]);
    };

    return { callHook, parse, resolve };
};

const getEmit = (
    collector: ReturnType<typeof createBackendModuleGraphCollector>,
    resolutions: Resolutions,
) => {
    const { callHook, parse, resolve } = getModuleParsedHook(collector, resolutions);

    // `importedIds` is what the bundler reports, deduplicated its own way:
    // Rollup by specifier, Rolldown by resolved id.
    const emit = (moduleInfo: FakeModuleInfo, importedIds: string[] = []) => {
        return callHook({ ...moduleInfo, importedIds });
    };

    return { emit, parse, resolve };
};

const getRecord = (
    collector: ReturnType<typeof createBackendModuleGraphCollector>,
    moduleId: string,
) => {
    const record = collector.getModuleRecords().get(moduleId);
    if (!record) {
        throw new Error(`Expected a module record for ${moduleId}`);
    }
    return record;
};

const importedIdsByName = (record: ReturnType<typeof getRecord>) => {
    const entries = [...record.importsByVariable].map(([variable, binding]) => [
        variable.name,
        binding.resolvedId,
    ]);
    return Object.fromEntries(entries);
};

describe('Backend Functions - backend module graph collector', () => {
    test('Should collect parsed local module records from moduleParsed hooks', async () => {
        const collector = createBackendModuleGraphCollector('/project');
        const { emit, parse } = getEmit(collector, {
            './helpers/http.js': '/project/src/backend/helpers/http.js?import',
        });

        await emit(
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
        await emit({
            id: '/project/node_modules/package/index.js',
            code: 'export const value = true;',
        });
        await emit({ id: '\0virtual-helper.js', code: 'export const value = true;' });
        await emit({ id: 'virtual:dd-backend-dev:example.js', code: 'export const value = true;' });
        await emit({ id: '/project/src/backend/external.js', code: null });

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
        // Filtering happens before the parse, so the skipped modules above never
        // reach the parser. Without that ordering every `node_modules` module in
        // the backend graph would be parsed just to be discarded.
        expect(parse).toHaveBeenCalledTimes(1);
    });

    test.each([
        {
            description: 'a repeated specifier (Rollup dedupes importedIds by specifier)',
            code: `
                import { a } from './x.js';
                export { b } from './y.js';
                import { c } from './x.js';
                export * from './w.js';
                import { d } from './z.js';
            `,
            importedIds: [
                '/project/src/x.js',
                '/project/src/y.js',
                '/project/src/w.js',
                '/project/src/z.js',
            ],
            expectedImports: {
                a: '/project/src/x.js',
                c: '/project/src/x.js',
                d: '/project/src/z.js',
            },
            expectedReExports: { b: '/project/src/y.js' },
            expectedStarExports: [{ resolvedId: '/project/src/w.js' }],
        },
        {
            description: 'two specifiers for one file (Rolldown dedupes importedIds by id)',
            code: `
                import { a } from './x.js';
                import { b } from './sub/../x.js';
                import { d } from './z.js';
            `,
            importedIds: ['/project/src/x.js', '/project/src/z.js'],
            expectedImports: {
                a: '/project/src/x.js',
                b: '/project/src/x.js',
                d: '/project/src/z.js',
            },
            expectedReExports: {},
            expectedStarExports: [],
        },
    ])(
        'Should pair every import with its own resolved id for $description',
        async ({ code, importedIds, expectedImports, expectedReExports, expectedStarExports }) => {
            const collector = createBackendModuleGraphCollector('/project');
            const { emit } = getEmit(collector, {
                './x.js': '/project/src/x.js',
                './sub/../x.js': '/project/src/x.js',
                './y.js': '/project/src/y.js',
                './w.js': '/project/src/w.js',
                './z.js': '/project/src/z.js',
            });

            await emit({ id: '/project/src/actions.backend.js', code }, importedIds);

            const record = getRecord(collector, '/project/src/actions.backend.js');
            const reExportEntries = [...record.exportsByName].flatMap(([name, binding]) =>
                binding.kind === 're-export' ? [[name, binding.resolvedId]] : [],
            );
            const imports = importedIdsByName(record);
            const reExports = Object.fromEntries(reExportEntries);
            expect(imports).toEqual(expectedImports);
            expect(reExports).toEqual(expectedReExports);
            expect(record.starExports).toEqual(expectedStarExports);
        },
    );

    test('Should resolve each distinct specifier once', async () => {
        const collector = createBackendModuleGraphCollector('/project');
        const { emit, resolve } = getEmit(collector, {
            './x.js': '/project/src/x.js',
            './z.js': '/project/src/z.js',
        });

        await emit(
            {
                id: '/project/src/actions.backend.js?import',
                code: `
                    import { a } from './x.js';
                    import { b } from './x.js';
                    export { c } from './x.js';
                    import { d } from './z.js';
                `,
            },
            ['/project/src/x.js', '/project/src/z.js'],
        );

        expect(resolve.mock.calls).toEqual([
            ['./x.js', '/project/src/actions.backend.js?import'],
            ['./z.js', '/project/src/actions.backend.js?import'],
        ]);
    });

    test('Should fail closed for an import the bundler cannot resolve', async () => {
        const collector = createBackendModuleGraphCollector('/project');
        const { emit } = getEmit(collector, { './x.js': '/project/src/x.js' });

        const emitted = emit(
            {
                id: '/project/src/actions.backend.js',
                code: `
                    import { a } from 'missing-package';
                    import { b } from './x.js';
                `,
            },
            ['missing-package', '/project/src/x.js'],
        );
        await expect(emitted).rejects.toThrow(
            'Unsupported local module graph for /project/src/actions.backend.js: unresolvable import specifier "missing-package" could hide an action-catalog connectionId.',
        );
        const records = collector.getModuleRecords();
        expect(records.size).toBe(0);
    });

    test('Should fail closed when an import resolves to a module the bundler did not load', async () => {
        const collector = createBackendModuleGraphCollector('/project');
        const { emit } = getEmit(collector, { './x.js': '/project/src/other.js' });

        const emitted = emit(
            { id: '/project/src/actions.backend.js', code: "import { a } from './x.js';" },
            ['/project/src/x.js'],
        );

        await expect(emitted).rejects.toThrow(
            'Unsupported local module graph for /project/src/actions.backend.js: import "./x.js" resolving to /project/src/other.js, which the bundler did not load, could hide an action-catalog connectionId.',
        );
        const records = collector.getModuleRecords();
        expect(records.size).toBe(0);
    });

    test('Should accept a package import that resolves differently from the bundler', async () => {
        const collector = createBackendModuleGraphCollector('/project');
        const { emit } = getEmit(collector, {
            'some-pkg': '/project/node_modules/some-pkg/other.js',
        });

        await emit({ id: '/project/src/helper.js', code: "import pkg from 'some-pkg';" }, [
            '/project/node_modules/some-pkg/index.js',
        ]);

        const record = getRecord(collector, '/project/src/helper.js');
        expect(record.staticDependencies).toEqual([
            { source: 'some-pkg', resolvedId: '/project/node_modules/some-pkg/other.js' },
        ]);
    });

    test('Should fail closed when the bundler loaded an import no source resolves to', async () => {
        const collector = createBackendModuleGraphCollector('/project');
        const { emit } = getEmit(collector, { './x.js': '/project/src/x.js' });

        const emitted = emit(
            { id: '/project/src/actions.backend.js', code: "import { a } from './x.js';" },
            ['/project/src/x.js', '/project/src/hidden.js'],
        );

        await expect(emitted).rejects.toThrow(
            'Unsupported local module graph for /project/src/actions.backend.js: loaded import /project/src/hidden.js that no static import/export source resolves to could hide an action-catalog connectionId.',
        );
        const records = collector.getModuleRecords();
        expect(records.size).toBe(0);
    });

    test('Should accept a loaded package that no static source names, as Rolldown reports require() targets', async () => {
        const collector = createBackendModuleGraphCollector('/project');
        const { emit } = getEmit(collector, { './x.js': '/project/src/x.js' });

        await emit(
            {
                id: '/project/src/helper.js',
                code: "import { a } from './x.js'; const pkg = require('some-pkg');",
            },
            ['/project/src/x.js', '/project/node_modules/some-pkg/index.js'],
        );

        const record = getRecord(collector, '/project/src/helper.js');
        expect(record.staticDependencies).toEqual([
            { source: './x.js', resolvedId: '/project/src/x.js' },
        ]);
    });

    test('Should not store a record when resolving an import fails', async () => {
        const collector = createBackendModuleGraphCollector('/project');
        const { callHook, resolve } = getModuleParsedHook(collector);
        const resolverError = new Error('resolver crashed');
        resolve.mockRejectedValueOnce(resolverError);

        const called = callHook({
            id: '/project/src/actions.backend.js',
            code: "import { a } from './x.js';",
            importedIds: ['/project/src/x.js'],
        });
        await expect(called).rejects.toThrow('resolver crashed');
        const records = collector.getModuleRecords();
        expect(records.size).toBe(0);
    });

    test('Should collect records under a bundler that does not support ModuleInfo#ast', async () => {
        const collector = createBackendModuleGraphCollector('/project');
        const { callHook } = getModuleParsedHook(collector);

        // Rolldown, Vite 8's default bundler, keeps `ast` on its Rollup-compat
        // object but stubs the getter to throw. Reading the property at all is
        // the failure, so it has to throw rather than be absent — which is also
        // why this is assembled in place instead of going through `getEmit`,
        // whose spread would trigger the getter during setup.
        const moduleInfo = {
            id: '/project/src/backend/actions.backend.ts',
            code: 'export const id = "conn-1";',
            importedIds: [],
        };
        Object.defineProperty(moduleInfo, 'ast', {
            get() {
                throw new Error('UNSUPPORTED: ModuleInfo#ast');
            },
            enumerable: true,
        });

        await callHook(moduleInfo);

        expect([...collector.getModuleRecords().keys()]).toEqual([
            '/project/src/backend/actions.backend.ts',
        ]);
    });

    test('Should store each record before later plugins run moduleParsed in a real Rollup build', async () => {
        const files: Record<string, string> = {
            '/project/src/actions.backend.js': `
                import { a } from './x.js';
                import { b } from './y.js';
                import { c } from './x.js';
                import { d } from './z.js';
                console.log(a, b, c, d);
            `,
            '/project/src/x.js': "export const a = 'x-a'; export const c = 'x-c';",
            '/project/src/y.js': "export const b = 'y-b';",
            '/project/src/z.js': "export const d = 'z-d';",
        };
        const collector = createBackendModuleGraphCollector('/project');
        const recordReadyWhenLaterPluginRan: Record<string, boolean> = {};

        const bundle = await rollup({
            input: '/project/src/actions.backend.js',
            logLevel: 'silent',
            plugins: [
                {
                    name: 'in-memory-files',
                    resolveId: (source, importer) =>
                        importer ? resolveFixtureSpecifier(source, importer) : source,
                    load: (id) => files[id],
                },
                collector.plugin,
                {
                    name: 'later-plugin',
                    moduleParsed(moduleInfo) {
                        recordReadyWhenLaterPluginRan[moduleInfo.id] = collector
                            .getModuleRecords()
                            .has(moduleInfo.id);
                    },
                },
            ],
        });
        await bundle.close();

        const moduleIds = Object.keys(files);
        const readyEntries = moduleIds.map((id) => [id, true]);
        const everyRecordReady = Object.fromEntries(readyEntries);
        expect(recordReadyWhenLaterPluginRan).toEqual(everyRecordReady);
        const record = getRecord(collector, '/project/src/actions.backend.js');
        const imports = importedIdsByName(record);
        expect(imports).toEqual({
            a: '/project/src/x.js',
            b: '/project/src/y.js',
            c: '/project/src/x.js',
            d: '/project/src/z.js',
        });
    });
});
