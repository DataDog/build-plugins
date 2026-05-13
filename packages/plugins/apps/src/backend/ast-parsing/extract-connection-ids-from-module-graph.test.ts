// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Program } from 'estree';
import { parseAst } from 'rollup/parseAst';

import { extractConnectionIdsFromModuleGraph } from './extract-connection-ids-from-module-graph';
import { createParsedModuleRecord, type ParsedModuleRecord } from './module-graph';

const buildRoot = '/project';
const entryId = '/project/src/backend/actions.backend.js';

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
        { description: 'dist output', resolvedId: '/project/dist/helper.js' },
        { description: 'build output', resolvedId: '/project/build/helper.js' },
        { description: 'Vite cache output', resolvedId: '/project/.vite/helper.js' },
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

    test('Should resolve imported connection ID values in reachable helpers', () => {
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
            [idsId],
        );
        const ids = createRecord(
            idsId,
            `
                export const HTTP_CONNECTION_ID = 'conn-imported';
            `,
        );

        expect(extract([entry, helper, ids])).toEqual(['conn-imported']);
    });

    test('Should resolve imported static templates, const chains, and object roots', () => {
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
                import { TEMPLATE_ID, ACTIVE_ID, CONNECTIONS } from './ids.js';

                export function getEcho() {
                    request({ connectionId: TEMPLATE_ID, inputs: {} });
                    request({ connectionId: ACTIVE_ID, inputs: {} });
                    request({ connectionId: CONNECTIONS.HTTP.PROD, inputs: {} });
                }
            `,
            [idsId],
        );
        const ids = createRecord(
            idsId,
            `
                const BASE_ID = 'conn-chain';

                export const TEMPLATE_ID = \`conn-template\`;
                export const ACTIVE_ID = BASE_ID;
                export const CONNECTIONS = {
                    HTTP: {
                        PROD: 'conn-object',
                    },
                };
            `,
        );

        expect(extract([entry, helper, ids])).toEqual([
            'conn-chain',
            'conn-object',
            'conn-template',
        ]);
    });

    test('Should resolve local export aliases, re-exports, import/export relays, and export star', () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const aliasesId = '/project/src/backend/helpers/aliases.js';
        const reExportsId = '/project/src/backend/helpers/re-exports.js';
        const relayId = '/project/src/backend/helpers/relay.js';
        const starId = '/project/src/backend/helpers/star.js';
        const sourceId = '/project/src/backend/helpers/source.js';
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
                import { ALIASED_ID } from './aliases.js';
                import { RE_EXPORTED_ID } from './re-exports.js';
                import { RELAYED_ID } from './relay.js';
                import { STAR_ID } from './star.js';

                export function getEcho() {
                    request({ connectionId: ALIASED_ID, inputs: {} });
                    request({ connectionId: RE_EXPORTED_ID, inputs: {} });
                    request({ connectionId: RELAYED_ID, inputs: {} });
                    request({ connectionId: STAR_ID, inputs: {} });
                }
            `,
            [aliasesId, reExportsId, relayId, starId],
        );
        const aliases = createRecord(
            aliasesId,
            `
                const ID = 'conn-alias';
                export { ID as ALIASED_ID };
            `,
        );
        const reExports = createRecord(
            reExportsId,
            `
                export { SOURCE_ID as RE_EXPORTED_ID } from './source.js';
            `,
            [sourceId],
        );
        const relay = createRecord(
            relayId,
            `
                import { SOURCE_ID as RELAYED_ID } from './source.js';
                export { RELAYED_ID };
            `,
            [sourceId],
        );
        const star = createRecord(
            starId,
            `
                export * from './source.js';
            `,
            [sourceId],
        );
        const source = createRecord(
            sourceId,
            `
                export const SOURCE_ID = 'conn-source';
                export const STAR_ID = 'conn-star';
            `,
        );

        expect(extract([entry, helper, aliases, reExports, relay, star, source])).toEqual([
            'conn-alias',
            'conn-source',
            'conn-star',
        ]);
    });

    test.each([
        {
            description: 'missing imported exports',
            sourceCode: 'export const OTHER_ID = "conn-other";',
            expectedMessage: 'missing export HTTP_CONNECTION_ID',
        },
        {
            description: 'mutable exported bindings',
            sourceCode: 'export let HTTP_CONNECTION_ID = "conn-mutable";',
            expectedMessage: 'mutable let exported connectionId binding HTTP_CONNECTION_ID',
        },
    ])('Should fail closed for $description', ({ sourceCode, expectedMessage }) => {
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
            [idsId],
        );
        const ids = createRecord(idsId, sourceCode);

        expect(() => extract([entry, helper, ids])).toThrow(expectedMessage);
    });

    test('Should fail closed for ambiguous export star connection IDs', () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const barrelId = '/project/src/backend/helpers/barrel.js';
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
                import { HTTP_CONNECTION_ID } from './barrel.js';

                export function getEcho() {
                    return request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                }
            `,
            [barrelId],
        );
        const barrel = createRecord(
            barrelId,
            `
                export * from './a.js';
                export * from './b.js';
            `,
            [aId, bId],
        );
        const a = createRecord(aId, `export const HTTP_CONNECTION_ID = 'conn-a';`);
        const b = createRecord(bId, `export const HTTP_CONNECTION_ID = 'conn-b';`);

        expect(() => extract([entry, helper, barrel, a, b])).toThrow(
            'ambiguous export * connectionId HTTP_CONNECTION_ID',
        );
    });

    test('Should fail closed for default imported connection IDs', () => {
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
                import HTTP_CONNECTION_ID from './ids.js';

                export function getEcho() {
                    return request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                }
            `,
            [idsId],
        );
        const ids = createRecord(idsId, `export const HTTP_CONNECTION_ID = 'conn';`);

        expect(() => extract([entry, helper, ids])).toThrow(
            'default imported connectionId binding HTTP_CONNECTION_ID',
        );
    });

    test('Should fail closed for cyclic import/export connection IDs', () => {
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
                import { HTTP_CONNECTION_ID } from './a.js';

                export function getEcho() {
                    return request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                }
            `,
            [aId],
        );
        const a = createRecord(aId, `export { HTTP_CONNECTION_ID } from './b.js';`, [bId]);
        const b = createRecord(bId, `export { HTTP_CONNECTION_ID } from './a.js';`, [aId]);

        expect(() => extract([entry, helper, a, b])).toThrow(
            'cyclic imported connectionId export HTTP_CONNECTION_ID',
        );
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
