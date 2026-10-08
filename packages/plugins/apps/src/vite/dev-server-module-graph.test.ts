// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAst } from 'rollup/parseAst';
import type { ViteDevServer } from 'vite';

import type { BackendRuntime } from '../backend-runtime';
import { LOCAL_EXECUTION_LOAD_SUFFIX } from '../constants';

import { collectModuleGraphFromServer } from './dev-server-module-graph';

const FIXTURE_ROOT = path.resolve(
    __dirname,
    '../../../../tests/src/_jest/fixtures/apps_backend_project',
);
const ENTRY_ID = path.join(FIXTURE_ROOT, 'helper.ts');
const SUFFIXED_ENTRY_ID = ENTRY_ID + LOCAL_EXECUTION_LOAD_SUFFIX;

/** A minimal fake ModuleNode shape, matching only the fields collectModuleGraphFromServer reads. */
interface FakeModuleNode {
    id: string;
    file?: string;
    importedModules: Set<FakeModuleNode>;
}

function makeFakeServer(
    resolveId: (specifier: string) => Promise<{ id: string } | null>,
    entryNode: FakeModuleNode = {
        id: SUFFIXED_ENTRY_ID,
        file: ENTRY_ID,
        importedModules: new Set(),
    },
) {
    return {
        moduleGraph: {
            getModuleById: (id: string) => (id === SUFFIXED_ENTRY_ID ? entryNode : undefined),
        },
        pluginContainer: {
            resolveId: (specifier: string) => resolveId(specifier),
        },
        // Real Vite resolves/transforms (never executes) each node before this collector reads
        // its `importedModules`; these fixtures pre-wire the full graph instead, so this is a
        // no-op stand-in for that priming call.
        transformRequest: async () => null,
    } as unknown as ViteDevServer;
}

interface FakeEnvironmentNode {
    id: string;
    transformResult: unknown;
    lastInvalidationTimestamp: number;
    lastHMRTimestamp: number;
}

const fakeEnvironmentNode = (
    id: string,
    state: 'edited' | 'hmr-updated' | 'current' | 'never-loaded',
): FakeEnvironmentNode => ({
    id,
    transformResult: state === 'current' ? { code: '' } : null,
    lastInvalidationTimestamp: state === 'edited' ? 1 : 0,
    lastHMRTimestamp: state === 'hmr-updated' ? 1 : 0,
});

// A Vite 6+ SSR environment graph where priming refills a node's transformResult.
function withSsrEnvironmentGraph(
    server: ViteDevServer,
    nodes: FakeEnvironmentNode[],
    onPrime: (id: string) => void = () => {},
) {
    const entries = nodes.map((node): [string, FakeEnvironmentNode] => [node.id, node]);
    const idToModuleMap = new Map(entries);
    const updateModuleTransformResult = jest.fn((node: FakeEnvironmentNode, result: unknown) => {
        node.transformResult = result;
    });
    const moduleGraph = {
        idToModuleMap,
        getModuleById: (id: string) => idToModuleMap.get(id),
        updateModuleTransformResult,
    };
    Object.assign(server, {
        environments: { ssr: { moduleGraph } },
        transformRequest: async (id: string) => {
            onPrime(id);
            const node = idToModuleMap.get(id);
            if (node) {
                node.transformResult = { code: '' };
            }
            return null;
        },
    });
    return { updateModuleTransformResult };
}

describe('dev-server-module-graph — collectModuleGraphFromServer', () => {
    describe('un-caching stale modules the walk primed', () => {
        const DEPENDENCY_ID = path.join(FIXTURE_ROOT, 'getRuntimeUsers.backend.ts');
        const OUTSIDE_ROOT_ID = path.join(FIXTURE_ROOT, '../shared/util.ts');
        const SDK_ID = path.join(FIXTURE_ROOT, 'node_modules/@datadog/apps-backend/index.js');
        const resolveToDependency = async () => ({ id: DEPENDENCY_ID });
        const collect = (server: ViteDevServer) => {
            const log = getMockLogger();
            return collectModuleGraphFromServer(
                server,
                ENTRY_ID,
                FIXTURE_ROOT,
                log,
                parseAst,
                'v1',
            );
        };
        const entryImporting = (...dependencyIds: string[]): FakeModuleNode => {
            const dependencies = dependencyIds.map((id) => ({
                id,
                file: id,
                importedModules: new Set<FakeModuleNode>(),
            }));
            return {
                id: SUFFIXED_ENTRY_ID,
                file: ENTRY_ID,
                importedModules: new Set(dependencies),
            };
        };

        test('Should un-cache an edited entry the walk primed', async () => {
            const server = makeFakeServer(resolveToDependency);
            const entry = fakeEnvironmentNode(SUFFIXED_ENTRY_ID, 'edited');
            const { updateModuleTransformResult } = withSsrEnvironmentGraph(server, [entry]);

            await collect(server);

            expect(updateModuleTransformResult).toHaveBeenCalledWith(entry, null);
            expect(entry.transformResult).toBeNull();
        });

        test('Should un-cache an edited dependency and the entry Vite invalidated with it', async () => {
            const entryNode = entryImporting(DEPENDENCY_ID);
            const server = makeFakeServer(resolveToDependency, entryNode);
            const entry = fakeEnvironmentNode(SUFFIXED_ENTRY_ID, 'edited');
            const dependency = fakeEnvironmentNode(DEPENDENCY_ID, 'edited');
            withSsrEnvironmentGraph(server, [entry, dependency]);

            await collect(server);

            expect(dependency.transformResult).toBeNull();
            expect(entry.transformResult).toBeNull();
        });

        test('Should un-cache a module Vite invalidated through HMR', async () => {
            const server = makeFakeServer(resolveToDependency);
            const entry = fakeEnvironmentNode(SUFFIXED_ENTRY_ID, 'hmr-updated');
            withSsrEnvironmentGraph(server, [entry]);

            await collect(server);

            expect(entry.transformResult).toBeNull();
        });

        test('Should un-cache an edited dependency outside the build root, e.g. a workspace package', async () => {
            const entryNode = entryImporting(OUTSIDE_ROOT_ID);
            const server = makeFakeServer(resolveToDependency, entryNode);
            const entry = fakeEnvironmentNode(SUFFIXED_ENTRY_ID, 'current');
            const outsideRoot = fakeEnvironmentNode(OUTSIDE_ROOT_ID, 'edited');
            withSsrEnvironmentGraph(server, [entry, outsideRoot]);

            await collect(server);

            expect(outsideRoot.transformResult).toBeNull();
        });

        test('Should un-cache edited app modules when the app itself lives under node_modules', async () => {
            const nestedRoot = path.join(FIXTURE_ROOT, 'node_modules/nested-app');
            const nestedEntryId = path.join(nestedRoot, 'helper.ts');
            const server = makeFakeServer(resolveToDependency);
            const entry = fakeEnvironmentNode(
                nestedEntryId + LOCAL_EXECUTION_LOAD_SUFFIX,
                'edited',
            );
            withSsrEnvironmentGraph(server, [entry]);
            const log = getMockLogger();

            await collectModuleGraphFromServer(
                server,
                nestedEntryId,
                nestedRoot,
                log,
                parseAst,
                'v1',
            );

            expect(entry.transformResult).toBeNull();
        });

        // A directory named like `..gen` is still inside the root, not a parent-directory path.
        test('Should un-cache an edited module in a `..`-prefixed directory of an app under node_modules', async () => {
            const nestedRoot = path.join(FIXTURE_ROOT, 'node_modules/nested-app');
            const dotPrefixedEntryId = path.join(nestedRoot, '..gen/helper.ts');
            const server = makeFakeServer(resolveToDependency);
            const entry = fakeEnvironmentNode(
                dotPrefixedEntryId + LOCAL_EXECUTION_LOAD_SUFFIX,
                'edited',
            );
            withSsrEnvironmentGraph(server, [entry]);
            const log = getMockLogger();

            await collectModuleGraphFromServer(
                server,
                dotPrefixedEntryId,
                nestedRoot,
                log,
                parseAst,
                'v1',
            );

            expect(entry.transformResult).toBeNull();
        });

        test('Should leave a hoisted sibling package cached when the app itself lives under node_modules', async () => {
            const nestedRoot = path.join(FIXTURE_ROOT, 'node_modules/nested-app');
            const nestedEntryId = path.join(nestedRoot, 'helper.ts');
            const hoistedSdkId = path.join(
                FIXTURE_ROOT,
                'node_modules/@datadog/apps-backend/index.js',
            );
            const nestedSuffixedEntryId = nestedEntryId + LOCAL_EXECUTION_LOAD_SUFFIX;
            // Reads the real fixture source, so the walk reaches the hoisted import.
            const nestedEntryNode: FakeModuleNode = {
                id: nestedSuffixedEntryId,
                file: ENTRY_ID,
                importedModules: new Set([
                    { id: hoistedSdkId, file: hoistedSdkId, importedModules: new Set() },
                ]),
            };
            const server = makeFakeServer(resolveToDependency, nestedEntryNode);
            Object.assign(server.moduleGraph, {
                getModuleById: (id: string) =>
                    id === nestedSuffixedEntryId ? nestedEntryNode : undefined,
            });
            const entry = fakeEnvironmentNode(nestedSuffixedEntryId, 'current');
            const hoistedSdk = fakeEnvironmentNode(hoistedSdkId, 'edited');
            const { updateModuleTransformResult } = withSsrEnvironmentGraph(server, [
                entry,
                hoistedSdk,
            ]);
            const log = getMockLogger();

            await collectModuleGraphFromServer(
                server,
                nestedEntryId,
                nestedRoot,
                log,
                parseAst,
                'v1',
            );

            expect(updateModuleTransformResult).not.toHaveBeenCalled();
        });

        test('Should un-cache a dependency saved while the walk is running', async () => {
            const entryNode = entryImporting(DEPENDENCY_ID);
            const server = makeFakeServer(resolveToDependency, entryNode);
            const entry = fakeEnvironmentNode(SUFFIXED_ENTRY_ID, 'current');
            const dependency = fakeEnvironmentNode(DEPENDENCY_ID, 'current');
            const saveDependencyWhenEntryPrimes = (id: string) => {
                if (id === SUFFIXED_ENTRY_ID) {
                    dependency.transformResult = null;
                    dependency.lastInvalidationTimestamp += 1;
                }
            };
            withSsrEnvironmentGraph(server, [entry, dependency], saveDependencyWhenEntryPrimes);

            await collect(server);

            expect(dependency.transformResult).toBeNull();
        });

        test("Should un-cache an edited dependency that another plugin's transform refilled before the walk primed it", async () => {
            const entryNode = entryImporting(DEPENDENCY_ID);
            const server = makeFakeServer(resolveToDependency, entryNode);
            const entry = fakeEnvironmentNode(SUFFIXED_ENTRY_ID, 'current');
            const dependency = fakeEnvironmentNode(DEPENDENCY_ID, 'edited');
            // Like a transform hook on the entry that pre-transforms its own imports.
            const transformImportsWhenEntryPrimes = (id: string) => {
                if (id === SUFFIXED_ENTRY_ID) {
                    dependency.transformResult = { code: '' };
                }
            };
            withSsrEnvironmentGraph(server, [entry, dependency], transformImportsWhenEntryPrimes);

            await collect(server);

            expect(dependency.transformResult).toBeNull();
        });

        // Arises when an untaken dynamic import's target is edited and the importer runs again.
        test('Should un-cache an edited dependency without re-running an importer that is current', async () => {
            const entryNode = entryImporting(DEPENDENCY_ID);
            const server = makeFakeServer(resolveToDependency, entryNode);
            const entry = fakeEnvironmentNode(SUFFIXED_ENTRY_ID, 'current');
            const dependency = fakeEnvironmentNode(DEPENDENCY_ID, 'edited');
            const { updateModuleTransformResult } = withSsrEnvironmentGraph(server, [
                entry,
                dependency,
            ]);

            await collect(server);

            expect(dependency.transformResult).toBeNull();
            expect(entry.transformResult).not.toBeNull();
            expect(updateModuleTransformResult).not.toHaveBeenCalledWith(entry, null);
        });

        // Vite invalidated it, so the runner would re-run it without the walk, and it isn't an SDK.
        test('Should un-cache an invalidated virtual module the walk primed', async () => {
            const virtualModuleId = '\0virtual:dd-generated-config';
            const entryNode: FakeModuleNode = {
                id: SUFFIXED_ENTRY_ID,
                file: ENTRY_ID,
                importedModules: new Set([{ id: virtualModuleId, importedModules: new Set() }]),
            };
            const server = makeFakeServer(resolveToDependency, entryNode);
            const entry = fakeEnvironmentNode(SUFFIXED_ENTRY_ID, 'current');
            const virtualModule = fakeEnvironmentNode(virtualModuleId, 'edited');
            withSsrEnvironmentGraph(server, [entry, virtualModule]);

            await collect(server);

            expect(virtualModule.transformResult).toBeNull();
        });

        test('Should leave a stale module the walk never primed alone', async () => {
            const server = makeFakeServer(resolveToDependency);
            const entry = fakeEnvironmentNode(SUFFIXED_ENTRY_ID, 'current');
            const unrelated = fakeEnvironmentNode(OUTSIDE_ROOT_ID, 'edited');
            const { updateModuleTransformResult } = withSsrEnvironmentGraph(server, [
                entry,
                unrelated,
            ]);

            await collect(server);

            expect(updateModuleTransformResult).not.toHaveBeenCalled();
        });

        test('Should leave modules that were already current cached', async () => {
            const entryNode = entryImporting(DEPENDENCY_ID);
            const server = makeFakeServer(resolveToDependency, entryNode);
            const entry = fakeEnvironmentNode(SUFFIXED_ENTRY_ID, 'current');
            const dependency = fakeEnvironmentNode(DEPENDENCY_ID, 'current');
            const { updateModuleTransformResult } = withSsrEnvironmentGraph(server, [
                entry,
                dependency,
            ]);

            await collect(server);

            expect(updateModuleTransformResult).not.toHaveBeenCalled();
        });

        test('Should leave a module Vite never invalidated cached, e.g. an untaken dynamic import', async () => {
            const entryNode = entryImporting(DEPENDENCY_ID);
            const server = makeFakeServer(resolveToDependency, entryNode);
            const entry = fakeEnvironmentNode(SUFFIXED_ENTRY_ID, 'current');
            const neverLoaded = fakeEnvironmentNode(DEPENDENCY_ID, 'never-loaded');
            const { updateModuleTransformResult } = withSsrEnvironmentGraph(server, [
                entry,
                neverLoaded,
            ]);

            await collect(server);

            expect(updateModuleTransformResult).not.toHaveBeenCalled();
        });

        test('Should leave an invalidated package dependency cached so an SDK keeps its setup', async () => {
            const entryNode = entryImporting(SDK_ID);
            const server = makeFakeServer(resolveToDependency, entryNode);
            const entry = fakeEnvironmentNode(SUFFIXED_ENTRY_ID, 'current');
            const sdk = fakeEnvironmentNode(SDK_ID, 'edited');
            const { updateModuleTransformResult } = withSsrEnvironmentGraph(server, [entry, sdk]);

            await collect(server);

            expect(updateModuleTransformResult).not.toHaveBeenCalled();
            expect(sdk.transformResult).not.toBeNull();
        });

        test('Should still un-cache an edited module when the walk fails partway', async () => {
            const server = makeFakeServer(async () => null);
            const entry = fakeEnvironmentNode(SUFFIXED_ENTRY_ID, 'edited');
            withSsrEnvironmentGraph(server, [entry]);

            const collecting = collect(server);

            await expect(collecting).rejects.toThrow(/unresolvable import specifier/);
            expect(entry.transformResult).toBeNull();
        });

        test('Should complete on a server without an SSR environment graph (Vite 5)', async () => {
            const server = makeFakeServer(resolveToDependency);

            const collecting = collect(server);

            await expect(collecting).resolves.toBeInstanceOf(Map);
        });
    });

    test('Should fail closed, not fall back to the raw specifier, when resolveId fails to resolve a static import', async () => {
        const server = makeFakeServer(async () => null);

        const log = getMockLogger();

        const collecting = collectModuleGraphFromServer(
            server,
            ENTRY_ID,
            FIXTURE_ROOT,
            log,
            parseAst,
            'v1',
        );

        await expect(collecting).rejects.toThrow(
            /unresolvable import specifier ".\/getRuntimeUsers\.backend"/,
        );
    });

    test('Should use the resolved id when resolveId succeeds', async () => {
        const resolvedPath = path.join(FIXTURE_ROOT, 'getRuntimeUsers.backend.ts');
        const server = makeFakeServer(async () => ({ id: resolvedPath }));

        const log = getMockLogger();

        const records = await collectModuleGraphFromServer(
            server,
            ENTRY_ID,
            FIXTURE_ROOT,
            log,
            parseAst,
            'v1',
        );

        expect(records.has(ENTRY_ID)).toBe(true);
    });

    test('Should throw a clear error when a module file cannot be read from disk', async () => {
        const missingFile = path.join(FIXTURE_ROOT, 'does-not-exist.ts');
        const entryNode: FakeModuleNode = {
            id: SUFFIXED_ENTRY_ID,
            file: missingFile,
            importedModules: new Set(),
        };
        const server = makeFakeServer(async () => null, entryNode);

        const log = getMockLogger();

        const collecting = collectModuleGraphFromServer(
            server,
            ENTRY_ID,
            FIXTURE_ROOT,
            log,
            parseAst,
            'v1',
        );

        await expect(collecting).rejects.toThrow(/unreadable module source/);
    });

    describe('when a module file fails to parse', () => {
        let tempDir: string;
        let badFile: string;

        beforeAll(() => {
            tempDir = mkdtempSync(path.join(tmpdir(), 'dev-server-module-graph-test-'));
            badFile = path.join(tempDir, 'broken.ts');
            writeFileSync(badFile, 'export function broken( {{{ this is not valid syntax');
        });

        afterAll(() => {
            rmSync(tempDir, { recursive: true, force: true });
        });

        test('Should throw a clear error instead of propagating the raw parser exception', async () => {
            const entryNode: FakeModuleNode = {
                id: SUFFIXED_ENTRY_ID,
                file: badFile,
                importedModules: new Set(),
            };
            const server = makeFakeServer(async () => null, entryNode);

            const log = getMockLogger();

            const collecting = collectModuleGraphFromServer(
                server,
                ENTRY_ID,
                FIXTURE_ROOT,
                log,
                parseAst,
                'v1',
            );

            await expect(collecting).rejects.toThrow(/unparseable module source/);
        });
    });

    test('Should fail closed on a dependency carrying a semantic Vite resource query (e.g. ?raw), instead of parsing it as ordinary source', async () => {
        const rawImportPath = path.join(FIXTURE_ROOT, 'snippet.ts');
        const rawImportNode: FakeModuleNode = {
            id: `${rawImportPath}?raw`,
            file: rawImportPath,
            importedModules: new Set(),
        };
        const entryNode: FakeModuleNode = {
            id: SUFFIXED_ENTRY_ID,
            file: ENTRY_ID,
            importedModules: new Set([rawImportNode]),
        };
        const server = makeFakeServer(async () => ({ id: rawImportPath }), entryNode);

        const log = getMockLogger();

        const collecting = collectModuleGraphFromServer(
            server,
            ENTRY_ID,
            FIXTURE_ROOT,
            log,
            parseAst,
            'v1',
        );

        await expect(collecting).rejects.toThrow(/Vite resource query on module id/);
    });

    test('Should fail closed on a semantic Vite resource query even when a plain (unqueried) node for the same file was visited first', async () => {
        const sharedFile = path.join(FIXTURE_ROOT, 'getRuntimeUsers.backend.ts');
        const plainNode: FakeModuleNode = {
            id: sharedFile,
            file: sharedFile,
            importedModules: new Set(),
        };
        const queriedNode: FakeModuleNode = {
            id: `${sharedFile}?raw`,
            file: sharedFile,
            importedModules: new Set(),
        };
        const entryNode: FakeModuleNode = {
            id: SUFFIXED_ENTRY_ID,
            file: ENTRY_ID,
            // Insertion order matters: the plain sibling (visited first) normalizes to the same
            // moduleId as the query'd node, which is what let the query'd node's rejection be
            // silently skipped by the visited-set dedup before the fix.
            importedModules: new Set([plainNode, queriedNode]),
        };
        const server = makeFakeServer(async () => ({ id: sharedFile }), entryNode);

        const log = getMockLogger();

        const collecting = collectModuleGraphFromServer(
            server,
            ENTRY_ID,
            FIXTURE_ROOT,
            log,
            parseAst,
            'v1',
        );

        await expect(collecting).rejects.toThrow(/Vite resource query on module id/);
    });

    test('Should not infinite-loop or double-process a module reached through a cycle in the import graph', async () => {
        const resolvedPath = path.join(FIXTURE_ROOT, 'getRuntimeUsers.backend.ts');
        const entryNode: FakeModuleNode = {
            id: SUFFIXED_ENTRY_ID,
            file: ENTRY_ID,
            importedModules: new Set(),
        };
        // A self-referential cycle: the entry "imports" itself via node.importedModules, the
        // same shape a real circular backend-to-backend import produces in Vite's own module
        // graph. The `visited` Set must stop this from being processed a second time.
        entryNode.importedModules.add(entryNode);
        const server = makeFakeServer(async () => ({ id: resolvedPath }), entryNode);

        const log = getMockLogger();

        const records = await collectModuleGraphFromServer(
            server,
            ENTRY_ID,
            FIXTURE_ROOT,
            log,
            parseAst,
            'v1',
        );

        expect(records.size).toBe(1);
        expect(records.has(ENTRY_ID)).toBe(true);
    });

    // The production build path checks every app-local module transitively, not just the
    // .backend.ts entry — local execution must reject the same banned helper the same way.
    const bannedHelperCases: Array<{ runtime: BackendRuntime; expected: unknown }> = [
        {
            runtime: 'v1',
            expected: expect.stringMatching(/Importing Node built-in module "fs" is not supported/),
        },
        { runtime: 'v2', expected: 'collected' },
    ];
    test.each(bannedHelperCases)(
        'Should apply the $runtime checks to a helper module transitively imported by a backend entry',
        async ({ runtime, expected }) => {
            const entryPath = path.join(FIXTURE_ROOT, 'viaBannedHelper.backend.ts');
            const bannedHelperPath = path.join(FIXTURE_ROOT, 'helperWithBannedImport.ts');
            const bannedHelperNode: FakeModuleNode = {
                id: bannedHelperPath,
                file: bannedHelperPath,
                importedModules: new Set(),
            };
            const entryNode: FakeModuleNode = {
                id: SUFFIXED_ENTRY_ID,
                file: entryPath,
                importedModules: new Set([bannedHelperNode]),
            };
            const server = makeFakeServer(async () => ({ id: bannedHelperPath }), entryNode);

            const log = getMockLogger();

            const outcome = await collectModuleGraphFromServer(
                server,
                ENTRY_ID,
                FIXTURE_ROOT,
                log,
                parseAst,
                runtime,
            ).then(
                () => 'collected',
                (error: unknown) => (error instanceof Error ? error.message : String(error)),
            );

            expect(outcome).toEqual(expected);
        },
    );
});
