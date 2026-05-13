// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Program } from 'estree';
import { parseAst } from 'rollup/parseAst';

import { extractConnectionIdsFromModuleGraph } from './extract-connection-ids-from-module-graph';
import { createParsedModuleRecord, type ParsedModuleRecord } from './module-graph';

const buildRoot = '/project';
const entryId = '/project/src/backend/actions.backend.js';
const actionCatalogId = '/project/node_modules/@datadog/action-catalog/http/http.js';

function parse(code: string): Program {
    return parseAst(code) as Program;
}

function createRecord(
    id: string,
    code: string,
    staticDependencies: string[] = [],
): ParsedModuleRecord {
    const record = createParsedModuleRecord(id, buildRoot, parse(code), staticDependencies);
    if (!record) {
        throw new Error(`Expected ${id} to create a parsed module record`);
    }
    return record;
}

function extract(records: ParsedModuleRecord[]): string[] {
    return extractConnectionIdsFromModuleGraph(
        entryId,
        new Map(records.map((record) => [record.id, record])),
        buildRoot,
    );
}

describe('Backend Functions - extractConnectionIdsFromModuleGraph', () => {
    test('Should return null when creating records for modules outside the backend graph', () => {
        expect(
            createParsedModuleRecord(
                '/project/node_modules/package/index.js',
                buildRoot,
                parse('export const value = true;'),
            ),
        ).toBeNull();
    });

    test('Should extract inline connection IDs from statically reachable helper modules', () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const entry = createRecord(
            entryId,
            `
                import { getEcho } from './helpers/http.js';

                export function run() {
                    return getEcho();
                }
            `,
            [helperId],
        );
        const helper = createRecord(
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
        const entry = createRecord(
            entryId,
            `
                import { getEcho } from './helpers/http.js';

                export function run() {
                    return getEcho();
                }
            `,
            [helperId],
        );
        const helper = createRecord(
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
        const entry = createRecord(
            entryId,
            `
                import './helpers/index.js';

                export function run() {}
            `,
            [barrelId],
        );
        const barrel = createRecord(
            barrelId,
            `
                export { getNamed } from './named.js';
                export * from './star.js';
            `,
            [namedId, starId],
        );
        const named = createRecord(
            namedId,
            `
                import { request } from '@datadog/action-catalog/http/http';
                export function getNamed() {
                    return request({ connectionId: 'conn-named', inputs: {} });
                }
            `,
        );
        const star = createRecord(
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
        const entry = createRecord(
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
        const entry = createRecord(
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
        const entry = createRecord(
            entryId,
            `
                import '../${folder}/helper.js';

                export function run() {}
            `,
            [helperId],
        );
        const helper = createRecord(
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
        const entry = createRecord(
            entryId,
            `
                import './a.js';

                export function run() {}
            `,
            [aId],
        );
        const a = createRecord(
            aId,
            `
                import './b.js';
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: 'conn-a', inputs: {} });
            `,
            [bId],
        );
        const b = createRecord(
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
        const entry = createRecord(
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
        const entry = createRecord(
            entryId,
            `
                import './missing.js';

                export function run() {}
            `,
            [missingId],
        );

        expect(() => extract([entry])).toThrow(`uncollected local import ${missingId}`);
    });

    test('Should resolve imported connection ID constants in reachable helpers', () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const idsId = '/project/src/backend/helpers/ids.js';
        const entry = createRecord(
            entryId,
            `
                import { getEcho } from './helpers/http.js';

                export function run() {
                    return getEcho();
                }
            `,
            [helperId],
        );
        const helper = createRecord(
            helperId,
            `
                import { request } from '@datadog/action-catalog/http/http';
                import { HTTP_CONNECTION_ID } from './ids.js';

                export function getEcho() {
                    return request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                }
            `,
            [actionCatalogId, idsId],
        );
        const ids = createRecord(
            idsId,
            `
                export const HTTP_CONNECTION_ID = 'conn-imported';
            `,
        );

        expect(extract([entry, helper, ids])).toEqual(['conn-imported']);
    });

    test('Should resolve imported static templates and const chains', () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const idsId = '/project/src/backend/helpers/ids.js';
        const entry = createRecord(
            entryId,
            `
                import { getEcho } from './helpers/http.js';
                export function run() {
                    return getEcho();
                }
            `,
            [helperId],
        );
        const helper = createRecord(
            helperId,
            `
                import { request } from '@datadog/action-catalog/http/http';
                import { ACTIVE_ID, TEMPLATE_ID } from './ids.js';

                export function getEcho() {
                    request({ connectionId: ACTIVE_ID, inputs: {} });
                    request({ connectionId: TEMPLATE_ID, inputs: {} });
                }
            `,
            [actionCatalogId, idsId],
        );
        const ids = createRecord(
            idsId,
            `
                const BASE_ID = 'conn-chain';
                export const ACTIVE_ID = BASE_ID;
                export const TEMPLATE_ID = \`conn-template\`;
            `,
        );

        expect(extract([entry, helper, ids])).toEqual(['conn-chain', 'conn-template']);
    });

    test('Should resolve imported object roots and nested static member paths', () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const idsId = '/project/src/backend/helpers/ids.js';
        const entry = createRecord(
            entryId,
            `
                import { getEcho } from './helpers/http.js';
                export function run() {
                    return getEcho();
                }
            `,
            [helperId],
        );
        const helper = createRecord(
            helperId,
            `
                import { request } from '@datadog/action-catalog/http/http';
                import { CONNECTIONS } from './ids.js';

                export function getEcho() {
                    request({ connectionId: CONNECTIONS.HTTP.PROD, inputs: {} });
                }
            `,
            [actionCatalogId, idsId],
        );
        const ids = createRecord(
            idsId,
            `
                const PROD_ID = 'conn-object';
                export const CONNECTIONS = {
                    HTTP: {
                        PROD: PROD_ID,
                    },
                };
            `,
        );

        expect(extract([entry, helper, ids])).toEqual(['conn-object']);
    });

    test('Should resolve local export aliases and re-export aliases', () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const barrelId = '/project/src/backend/helpers/index.js';
        const idsId = '/project/src/backend/helpers/ids.js';
        const entry = createRecord(
            entryId,
            `
                import { getEcho } from './helpers/http.js';
                export function run() {
                    return getEcho();
                }
            `,
            [helperId],
        );
        const helper = createRecord(
            helperId,
            `
                import { request } from '@datadog/action-catalog/http/http';
                import { HTTP_ID, SLACK_ID } from './helpers/index.js';

                export function getEcho() {
                    request({ connectionId: HTTP_ID, inputs: {} });
                    request({ connectionId: SLACK_ID, inputs: {} });
                }
            `,
            [actionCatalogId, barrelId],
        );
        const barrel = createRecord(
            barrelId,
            `
                export { LOCAL_ID as HTTP_ID };
                export { REMOTE_ID as SLACK_ID } from './ids.js';

                const LOCAL_ID = 'conn-local-alias';
            `,
            [idsId],
        );
        const ids = createRecord(
            idsId,
            `
                export const REMOTE_ID = 'conn-reexport';
            `,
        );

        expect(extract([entry, helper, barrel, ids])).toEqual([
            'conn-local-alias',
            'conn-reexport',
        ]);
    });

    test('Should resolve local import/export relays and unambiguous export stars', () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const barrelId = '/project/src/backend/helpers/index.js';
        const relayId = '/project/src/backend/helpers/relay.js';
        const idsId = '/project/src/backend/helpers/ids.js';
        const entry = createRecord(
            entryId,
            `
                import { getEcho } from './helpers/http.js';
                export function run() {
                    return getEcho();
                }
            `,
            [helperId],
        );
        const helper = createRecord(
            helperId,
            `
                import { request } from '@datadog/action-catalog/http/http';
                import { RELAY_ID, STAR_ID } from './helpers/index.js';

                export function getEcho() {
                    request({ connectionId: RELAY_ID, inputs: {} });
                    request({ connectionId: STAR_ID, inputs: {} });
                }
            `,
            [actionCatalogId, barrelId],
        );
        const barrel = createRecord(
            barrelId,
            `
                export { RELAY_ID } from './relay.js';
                export * from './ids.js';
            `,
            [relayId, idsId],
        );
        const relay = createRecord(
            relayId,
            `
                import { SOURCE_ID as RELAY_ID } from './ids.js';
                export { RELAY_ID };
            `,
            [idsId],
        );
        const ids = createRecord(
            idsId,
            `
                export const SOURCE_ID = 'conn-relay';
                export const STAR_ID = 'conn-star-id';
            `,
        );

        expect(extract([entry, helper, barrel, relay, ids])).toEqual([
            'conn-relay',
            'conn-star-id',
        ]);
    });

    test('Should fail closed for ambiguous export stars', () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const barrelId = '/project/src/backend/helpers/index.js';
        const aId = '/project/src/backend/helpers/a.js';
        const bId = '/project/src/backend/helpers/b.js';
        const entry = createRecord(
            entryId,
            `
                import { getEcho } from './helpers/http.js';
                export function run() {
                    return getEcho();
                }
            `,
            [helperId],
        );
        const helper = createRecord(
            helperId,
            `
                import { request } from '@datadog/action-catalog/http/http';
                import { HTTP_ID } from './helpers/index.js';

                export function getEcho() {
                    request({ connectionId: HTTP_ID, inputs: {} });
                }
            `,
            [actionCatalogId, barrelId],
        );
        const barrel = createRecord(
            barrelId,
            `
                export * from './a.js';
                export * from './b.js';
            `,
            [aId, bId],
        );
        const a = createRecord(aId, "export const HTTP_ID = 'conn-a';");
        const b = createRecord(bId, "export const HTTP_ID = 'conn-b';");

        expect(() => extract([entry, helper, barrel, a, b])).toThrow(
            'ambiguous star export HTTP_ID',
        );
    });

    test.each([
        {
            description: 'missing exports',
            idsCode: "export const OTHER_ID = 'conn';",
            expectedMessage: 'missing export HTTP_ID',
        },
        {
            description: 'mutable exported bindings',
            idsCode: "export let HTTP_ID = 'conn';",
            expectedMessage: 'mutable let exported connectionId binding HTTP_ID',
        },
        {
            description: 'reassigned exported bindings',
            idsCode: "export const HTTP_ID = 'conn'; HTTP_ID = 'changed';",
            expectedMessage: 'reassigned exported connectionId binding HTTP_ID',
        },
        {
            description: 'default imports',
            importClause: 'HTTP_ID',
            idsCode: "export default 'conn';",
            expectedMessage: 'default import HTTP_ID',
        },
    ])(
        'Should fail closed for $description',
        ({
            importClause = '{ HTTP_ID }',
            idsCode,
            expectedMessage,
        }: {
            importClause?: string;
            idsCode: string;
            expectedMessage: string;
        }) => {
            const helperId = '/project/src/backend/helpers/http.js';
            const idsId = '/project/src/backend/helpers/ids.js';
            const entry = createRecord(
                entryId,
                `
                    import { getEcho } from './helpers/http.js';
                    export function run() {
                        return getEcho();
                    }
                `,
                [helperId],
            );
            const helper = createRecord(
                helperId,
                `
                    import { request } from '@datadog/action-catalog/http/http';
                    import ${importClause} from './ids.js';

                    export function getEcho() {
                        request({ connectionId: HTTP_ID, inputs: {} });
                    }
                `,
                [actionCatalogId, idsId],
            );
            const ids = createRecord(idsId, idsCode);

            expect(() => extract([entry, helper, ids])).toThrow(expectedMessage);
        },
    );

    test('Should fail closed for cyclic import/export chains', () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const aId = '/project/src/backend/helpers/a.js';
        const bId = '/project/src/backend/helpers/b.js';
        const entry = createRecord(
            entryId,
            `
                import { getEcho } from './helpers/http.js';
                export function run() {
                    return getEcho();
                }
            `,
            [helperId],
        );
        const helper = createRecord(
            helperId,
            `
                import { request } from '@datadog/action-catalog/http/http';
                import { A } from './helpers/a.js';

                export function getEcho() {
                    request({ connectionId: A, inputs: {} });
                }
            `,
            [actionCatalogId, aId],
        );
        const a = createRecord(
            aId,
            `
                import { B } from './b.js';
                export const A = B;
            `,
            [bId],
        );
        const b = createRecord(
            bId,
            `
                import { A } from './a.js';
                export const B = A;
            `,
            [aId],
        );

        expect(() => extract([entry, helper, a, b])).toThrow('cyclic import/export chain');
    });

    test('Should read transformed local TypeScript helpers as collected records', () => {
        const helperId = '/project/src/backend/helpers/http.ts';
        const entry = createRecord(
            entryId,
            `
                import { getEcho } from './helpers/http';

                export function run() {
                    return getEcho();
                }
            `,
            [helperId],
        );
        const helper = createRecord(
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
