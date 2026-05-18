// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { extractConnectionIdsFromModuleGraph } from './extract-connection-ids-from-module-graph';
import { createParsedModuleRecord, type ParsedModuleRecord } from './module-graph';
import {
    createTestModuleMap,
    createTestParsedModuleRecord,
    parseTestProgram,
    testBuildRoot,
} from './test-helpers.test-helper';

const entryId = '/project/src/backend/actions.backend.js';

function extract(records: ParsedModuleRecord[]): string[] {
    return extractConnectionIdsFromModuleGraph(
        entryId,
        createTestModuleMap(records),
        testBuildRoot,
    );
}

describe('Backend Functions - extractConnectionIdsFromModuleGraph', () => {
    test('Should return null when creating records for modules outside the backend graph', () => {
        expect(
            createParsedModuleRecord(
                '/project/node_modules/package/index.js',
                testBuildRoot,
                parseTestProgram('export const value = true;'),
            ),
        ).toBeNull();
    });

    test('Should extract inline connection IDs from statically reachable helper modules', () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const entry = createTestParsedModuleRecord(
            entryId,
            `
                import { getEcho } from './helpers/http.js';

                export function run() {
                    return getEcho();
                }
            `,
            [helperId],
        );
        const helper = createTestParsedModuleRecord(
            helperId,
            `
                import { request } from '@datadog/action-catalog/http/http';

                export function getEcho() {
                    return request({ connectionId: 'conn-helper', inputs: {} });
                }
            `,
        );

        expect(extract([entry, helper])).toEqual(['conn-helper']);
    });

    test('Should resolve same-module connection ID values inside reachable helpers', () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const entry = createTestParsedModuleRecord(
            entryId,
            `
                import { getEcho } from './helpers/http.js';

                export function run() {
                    return getEcho();
                }
            `,
            [helperId],
        );
        const helper = createTestParsedModuleRecord(
            helperId,
            `
                import { request } from '@datadog/action-catalog/http/http';

                const HTTP_CONNECTION_ID = 'conn-const';
                const CONNECTIONS = { HTTP: { PROD: 'conn-object' } };

                export function getEcho() {
                    request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                    request({ connectionId: CONNECTIONS.HTTP.PROD, inputs: {} });
                }
            `,
        );

        expect(extract([entry, helper])).toEqual(['conn-const', 'conn-object']);
    });

    test('Should traverse named re-exports and export star declarations', () => {
        const barrelId = '/project/src/backend/helpers/index.js';
        const namedId = '/project/src/backend/helpers/named.js';
        const starId = '/project/src/backend/helpers/star.js';
        const entry = createTestParsedModuleRecord(
            entryId,
            `
                import './helpers/index.js';

                export function run() {}
            `,
            [barrelId],
        );
        const barrel = createTestParsedModuleRecord(
            barrelId,
            `
                export { getNamed } from './named.js';
                export * from './star.js';
            `,
            [namedId, starId],
        );
        const named = createTestParsedModuleRecord(
            namedId,
            `
                import { request } from '@datadog/action-catalog/http/http';
                export function getNamed() {
                    return request({ connectionId: 'conn-named', inputs: {} });
                }
            `,
        );
        const star = createTestParsedModuleRecord(
            starId,
            `
                import { request } from '@datadog/action-catalog/http/http';
                export function getStar() {
                    return request({ connectionId: 'conn-star', inputs: {} });
                }
            `,
        );

        expect(extract([entry, barrel, named, star])).toEqual(['conn-named', 'conn-star']);
    });

    test('Should ignore package imports while traversing collected records', () => {
        const entry = createTestParsedModuleRecord(
            entryId,
            `
                import { helper } from 'some-package';

                export function run() {}
            `,
            ['/project/node_modules/some-package/index.js'],
        );

        expect(extract([entry])).toEqual([]);
    });

    test.each([
        { description: 'outside buildRoot', resolvedId: '/external/helper.js' },
        { description: 'virtual modules', resolvedId: '\0virtual-helper.js' },
        { description: 'package modules', resolvedId: '/project/node_modules/package/index.js' },
        {
            description: 'Yarn package cache modules',
            resolvedId: '/project/.yarn/cache/package/index.js',
        },
        { description: 'non-JavaScript files', resolvedId: '/project/src/backend/data.json' },
    ])('Should skip $description', ({ resolvedId }) => {
        const entry = createTestParsedModuleRecord(
            entryId,
            `
                import './helper.js';

                export function run() {}
            `,
            [resolvedId],
        );

        expect(extract([entry])).toEqual([]);
    });

    test.each([
        { folder: 'dist', connectionId: 'conn-dist' },
        { folder: 'build', connectionId: 'conn-build' },
        { folder: '.vite', connectionId: 'conn-vite' },
    ])('Should traverse supported app-local folder name $folder', ({ folder, connectionId }) => {
        const helperId = `/project/${folder}/helper.js`;
        const entry = createTestParsedModuleRecord(
            entryId,
            `
                import '../${folder}/helper.js';

                export function run() {}
            `,
            [helperId],
        );
        const helper = createTestParsedModuleRecord(
            helperId,
            `
                import { request } from '@datadog/action-catalog/http/http';

                request({ connectionId: '${connectionId}', inputs: {} });
            `,
        );

        expect(extract([entry, helper])).toEqual([connectionId]);
    });

    test('Should protect against local graph cycles', () => {
        const aId = '/project/src/backend/a.js';
        const bId = '/project/src/backend/b.js';
        const entry = createTestParsedModuleRecord(
            entryId,
            `
                import './a.js';

                export function run() {}
            `,
            [aId],
        );
        const a = createTestParsedModuleRecord(
            aId,
            `
                import './b.js';
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: 'conn-a', inputs: {} });
            `,
            [bId],
        );
        const b = createTestParsedModuleRecord(
            bId,
            `
                import './a.js';
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: 'conn-b', inputs: {} });
            `,
            [aId],
        );

        expect(extract([entry, a, b])).toEqual(['conn-a', 'conn-b']);
    });

    test.each([
        {
            description: 'dynamic local imports',
            code: "import('./helper.js');",
            message: 'dynamic-import ./helper.js',
        },
        {
            description: 'non-literal dynamic imports',
            code: 'import(helperPath);',
            message: 'dynamic-import non-literal dynamic import',
        },
        {
            description: 'local require calls',
            code: "require('./helper.js');",
            message: 'require ./helper.js',
        },
    ])('Should fail closed for $description', ({ code, message }) => {
        const entry = createTestParsedModuleRecord(
            entryId,
            `
                ${code}

                export function run() {}
            `,
        );

        expect(() => extract([entry])).toThrow(message);
    });

    test('Should fail closed for uncollected local static imports', () => {
        const missingId = '/project/src/backend/missing.js';
        const entry = createTestParsedModuleRecord(
            entryId,
            `
                import './missing.js';

                export function run() {}
            `,
            [missingId],
        );

        expect(() => extract([entry])).toThrow(`uncollected local import ${missingId}`);
    });

    test('Should keep imported connection ID values unsupported in reachable helpers', () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const idsId = '/project/src/backend/helpers/ids.js';
        const entry = createTestParsedModuleRecord(
            entryId,
            `
                import { getEcho } from './helpers/http.js';

                export function run() {
                    return getEcho();
                }
            `,
            [helperId],
        );
        const helper = createTestParsedModuleRecord(
            helperId,
            `
                import { request } from '@datadog/action-catalog/http/http';
                import { HTTP_CONNECTION_ID } from './ids.js';

                export function getEcho() {
                    return request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                }
            `,
            [idsId],
        );

        expect(() => extract([entry, helper])).toThrow(
            'imported connectionId binding HTTP_CONNECTION_ID',
        );
    });

    test('Should read transformed local TypeScript helpers as collected records', () => {
        const helperId = '/project/src/backend/helpers/http.ts';
        const entry = createTestParsedModuleRecord(
            entryId,
            `
                import { getEcho } from './helpers/http';

                export function run() {
                    return getEcho();
                }
            `,
            [helperId],
        );
        const helper = createTestParsedModuleRecord(
            helperId,
            `
                import { request } from '@datadog/action-catalog/http/http';

                const HTTP_CONNECTION_ID = 'conn-ts';

                export function getEcho() {
                    request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                    return { ok: true };
                }
            `,
        );

        expect(extract([entry, helper])).toEqual(['conn-ts']);
    });
});
