// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BackendFunction } from '@dd/apps-plugin/backend/types';
import type { AppsOptionsWithDefaults } from '@dd/apps-plugin/types';
import { buildManifest } from '@dd/apps-plugin/vite/handle-upload';

const baseOptions: AppsOptionsWithDefaults = {
    include: [],
    dryRun: true,
    authOverrides: { method: 'apiKey' },
};

const makeFunction = (overrides: Partial<BackendFunction> = {}): BackendFunction => ({
    relativePath: 'src/my-function.backend',
    name: 'myFunction',
    absolutePath: '/root/src/my-function.backend.ts',
    allowedConnectionIds: [],
    ...overrides,
});

describe('Apps Plugin - buildManifest', () => {
    test('Should merge secretConnections into every function, even those with no code-derived connections', () => {
        const manifest = buildManifest([makeFunction()], {
            ...baseOptions,
            secretConnections: ['secret-conn-1'],
        });

        const [functionEntry] = Object.values(manifest.backend.functions);
        expect(functionEntry.allowedConnectionIds).toEqual(['secret-conn-1']);
    });

    test('Should merge secretConnections alongside a function-code-derived connection, deduped', () => {
        const manifest = buildManifest(
            [makeFunction({ allowedConnectionIds: ['code-conn', 'secret-conn-1'] })],
            { ...baseOptions, secretConnections: ['secret-conn-1', 'secret-conn-2'] },
        );

        const [functionEntry] = Object.values(manifest.backend.functions);
        expect(functionEntry.allowedConnectionIds).toEqual([
            'code-conn',
            'secret-conn-1',
            'secret-conn-2',
        ]);
    });

    test('Should apply secretConnections to every function independently', () => {
        const manifest = buildManifest(
            [
                makeFunction({ relativePath: 'src/a.backend', name: 'a' }),
                makeFunction({
                    relativePath: 'src/b.backend',
                    name: 'b',
                    allowedConnectionIds: ['b-only'],
                }),
            ],
            { ...baseOptions, secretConnections: ['shared-conn'] },
        );

        const entries = Object.values(manifest.backend.functions);
        expect(entries).toHaveLength(2);
        for (const entry of entries) {
            expect(entry.allowedConnectionIds).toContain('shared-conn');
        }
        expect(
            entries.find((e) => e.allowedConnectionIds.includes('b-only'))?.allowedConnectionIds,
        ).toEqual(['b-only', 'shared-conn']);
    });

    test('Should leave allowedConnectionIds untouched when secretConnections is not configured', () => {
        const manifest = buildManifest(
            [makeFunction({ allowedConnectionIds: ['code-conn'] })],
            baseOptions,
        );

        const [functionEntry] = Object.values(manifest.backend.functions);
        expect(functionEntry.allowedConnectionIds).toEqual(['code-conn']);
    });
});
