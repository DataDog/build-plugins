// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

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

function makeFakeServer(resolveId: (specifier: string) => Promise<{ id: string } | null>) {
    return {
        moduleGraph: {
            getModuleById: (id: string) =>
                id === SUFFIXED_ENTRY_ID
                    ? { id: SUFFIXED_ENTRY_ID, file: ENTRY_ID, importedModules: new Set() }
                    : undefined,
        },
        pluginContainer: {
            resolveId: (specifier: string) => resolveId(specifier),
        },
    } as unknown as ViteDevServer;
}

describe('dev-server-module-graph — collectModuleGraphFromServer', () => {
    test('Should fail closed, not fall back to the raw specifier, when resolveId fails to resolve a static import', async () => {
        const server = makeFakeServer(async () => null);

        await expect(collectModuleGraphFromServer(server, ENTRY_ID, FIXTURE_ROOT)).rejects.toThrow(
            /unresolvable import specifier ".\/getRuntimeUsers\.backend"/,
        );
    });

    test('Should use the resolved id when resolveId succeeds', async () => {
        const resolvedPath = path.join(FIXTURE_ROOT, 'getRuntimeUsers.backend.ts');
        const server = makeFakeServer(async () => ({ id: resolvedPath }));

        const records = await collectModuleGraphFromServer(server, ENTRY_ID, FIXTURE_ROOT);

        expect(records.has(ENTRY_ID)).toBe(true);
    });
});
