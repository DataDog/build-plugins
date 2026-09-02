// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ViteDevServer } from 'vite';

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

describe('dev-server-module-graph — collectModuleGraphFromServer', () => {
    test('Should fail closed, not fall back to the raw specifier, when resolveId fails to resolve a static import', async () => {
        const server = makeFakeServer(async () => null);

        await expect(
            collectModuleGraphFromServer(server, ENTRY_ID, FIXTURE_ROOT, getMockLogger()),
        ).rejects.toThrow(/unresolvable import specifier ".\/getRuntimeUsers\.backend"/);
    });

    test('Should use the resolved id when resolveId succeeds', async () => {
        const resolvedPath = path.join(FIXTURE_ROOT, 'getRuntimeUsers.backend.ts');
        const server = makeFakeServer(async () => ({ id: resolvedPath }));

        const records = await collectModuleGraphFromServer(
            server,
            ENTRY_ID,
            FIXTURE_ROOT,
            getMockLogger(),
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

        await expect(
            collectModuleGraphFromServer(server, ENTRY_ID, FIXTURE_ROOT, getMockLogger()),
        ).rejects.toThrow(/unreadable module source/);
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

            await expect(
                collectModuleGraphFromServer(server, ENTRY_ID, FIXTURE_ROOT, getMockLogger()),
            ).rejects.toThrow(/unparseable module source/);
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

        await expect(
            collectModuleGraphFromServer(server, ENTRY_ID, FIXTURE_ROOT, getMockLogger()),
        ).rejects.toThrow(/Vite resource query on module id/);
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

        await expect(
            collectModuleGraphFromServer(server, ENTRY_ID, FIXTURE_ROOT, getMockLogger()),
        ).rejects.toThrow(/Vite resource query on module id/);
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

        const records = await collectModuleGraphFromServer(
            server,
            ENTRY_ID,
            FIXTURE_ROOT,
            getMockLogger(),
        );

        expect(records.size).toBe(1);
        expect(records.has(ENTRY_ID)).toBe(true);
    });

    // The production build path checks every app-local module transitively, not just the
    // .backend.ts entry — local execution must reject the same banned helper the same way.
    test('Should reject a helper module transitively imported by a backend entry when it imports a banned Node builtin', async () => {
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

        await expect(
            collectModuleGraphFromServer(server, ENTRY_ID, FIXTURE_ROOT, getMockLogger()),
        ).rejects.toThrow(/Importing Node built-in module "fs" is not supported/);
    });
});
