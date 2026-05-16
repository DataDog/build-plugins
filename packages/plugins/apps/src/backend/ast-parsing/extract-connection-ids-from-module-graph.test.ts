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

    test.each([
        {
            description: 'string constants',
            idsCode: "export const HTTP_CONNECTION_ID = 'conn-imported';",
            helperValue: 'HTTP_CONNECTION_ID',
            expected: 'conn-imported',
        },
        {
            description: 'static template literals',
            idsCode: 'export const HTTP_CONNECTION_ID = `conn-template`;',
            helperValue: 'HTTP_CONNECTION_ID',
            expected: 'conn-template',
        },
        {
            description: 'const-to-const chains',
            idsCode: `
                const BASE_CONNECTION_ID = 'conn-chain';
                export const HTTP_CONNECTION_ID = BASE_CONNECTION_ID;
            `,
            helperValue: 'HTTP_CONNECTION_ID',
            expected: 'conn-chain',
        },
        {
            description: 'object member reads',
            idsCode: "export const CONNECTIONS = { HTTP: 'conn-object' };",
            helperValue: 'CONNECTIONS.HTTP',
            expected: 'conn-object',
        },
        {
            description: 'nested object member reads',
            idsCode: "export const CONNECTIONS = { HTTP: { PROD: 'conn-nested' } };",
            helperValue: 'CONNECTIONS.HTTP.PROD',
            expected: 'conn-nested',
        },
        {
            description: 'object member values that reference constants',
            idsCode: `
                const HTTP_CONNECTION_ID = 'conn-object-chain';
                export const CONNECTIONS = { HTTP: HTTP_CONNECTION_ID };
            `,
            helperValue: 'CONNECTIONS.HTTP',
            expected: 'conn-object-chain',
        },
    ])(
        'Should resolve imported connection ID $description',
        ({ idsCode, helperValue, expected }) => {
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
                import { CONNECTIONS, HTTP_CONNECTION_ID } from './ids.js';

                export function getEcho() {
                    return request({ connectionId: ${helperValue}, inputs: {} });
                }
            `,
                [actionCatalogId, idsId],
            );
            const ids = createRecord(idsId, idsCode);

            expect(extract([entry, helper, ids])).toEqual([expected]);
        },
    );

    test.each([
        {
            description: 'local export aliases',
            idsCode: `
                const HTTP_CONNECTION_ID = 'conn-alias';
                export { HTTP_CONNECTION_ID as ACTIVE_HTTP_CONNECTION_ID };
            `,
            indexCode: "export { ACTIVE_HTTP_CONNECTION_ID } from './ids.js';",
            importName: 'ACTIVE_HTTP_CONNECTION_ID',
            expected: 'conn-alias',
        },
        {
            description: 'named re-export aliases',
            idsCode: "export const HTTP_CONNECTION_ID = 'conn-re-export';",
            indexCode:
                "export { HTTP_CONNECTION_ID as ACTIVE_HTTP_CONNECTION_ID } from './ids.js';",
            importName: 'ACTIVE_HTTP_CONNECTION_ID',
            expected: 'conn-re-export',
        },
        {
            description: 'local import/export relays',
            idsCode: "export const HTTP_CONNECTION_ID = 'conn-relay';",
            indexCode: `
                import { HTTP_CONNECTION_ID } from './ids.js';
                export { HTTP_CONNECTION_ID as ACTIVE_HTTP_CONNECTION_ID };
            `,
            importName: 'ACTIVE_HTTP_CONNECTION_ID',
            expected: 'conn-relay',
        },
        {
            description: 'unambiguous star exports',
            idsCode: "export const HTTP_CONNECTION_ID = 'conn-star-export';",
            indexCode: "export * from './ids.js';",
            importName: 'HTTP_CONNECTION_ID',
            expected: 'conn-star-export',
        },
    ])(
        'Should resolve imported connection IDs through $description',
        ({ idsCode, indexCode, importName, expected }) => {
            const helperId = '/project/src/backend/helpers/http.js';
            const indexId = '/project/src/backend/helpers/index.js';
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
                    import { ${importName} } from './index.js';

                    export function getEcho() {
                        return request({ connectionId: ${importName}, inputs: {} });
                    }
                `,
                [actionCatalogId, indexId],
            );
            const index = createRecord(indexId, indexCode, [idsId]);
            const ids = createRecord(idsId, idsCode);

            expect(extract([entry, helper, index, ids])).toEqual([expected]);
        },
    );

    test.each([
        {
            description: 'missing exports',
            records: () => {
                const helperId = '/project/src/backend/helpers/http.js';
                const indexId = '/project/src/backend/helpers/index.js';
                const idsId = '/project/src/backend/helpers/ids.js';
                return [
                    createRecord(entryId, "import { getEcho } from './helpers/http.js';", [
                        helperId,
                    ]),
                    createRecord(
                        helperId,
                        `
                            import { request } from '@datadog/action-catalog/http/http';
                            import { HTTP_CONNECTION_ID } from './index.js';
                            request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                        `,
                        [actionCatalogId, indexId],
                    ),
                    createRecord(indexId, "export * from './ids.js';", [idsId]),
                    createRecord(idsId, "export const OTHER_CONNECTION_ID = 'conn-other';"),
                ];
            },
            expectedMessage: 'unsupported static definition missing-export',
        },
        {
            description: 'ambiguous star exports',
            records: () => {
                const helperId = '/project/src/backend/helpers/http.js';
                const indexId = '/project/src/backend/helpers/index.js';
                const oneId = '/project/src/backend/helpers/one.js';
                const twoId = '/project/src/backend/helpers/two.js';
                return [
                    createRecord(entryId, "import { getEcho } from './helpers/http.js';", [
                        helperId,
                    ]),
                    createRecord(
                        helperId,
                        `
                            import { request } from '@datadog/action-catalog/http/http';
                            import { HTTP_CONNECTION_ID } from './index.js';
                            request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                        `,
                        [actionCatalogId, indexId],
                    ),
                    createRecord(
                        indexId,
                        `
                            export * from './one.js';
                            export * from './two.js';
                        `,
                        [oneId, twoId],
                    ),
                    createRecord(oneId, "export const HTTP_CONNECTION_ID = 'conn-one';"),
                    createRecord(twoId, "export const HTTP_CONNECTION_ID = 'conn-two';"),
                ];
            },
            expectedMessage: 'unsupported static definition ambiguous-star-export',
        },
        {
            description: 'import/export cycles',
            records: () => {
                const helperId = '/project/src/backend/helpers/http.js';
                const oneId = '/project/src/backend/helpers/one.js';
                const twoId = '/project/src/backend/helpers/two.js';
                return [
                    createRecord(entryId, "import { getEcho } from './helpers/http.js';", [
                        helperId,
                    ]),
                    createRecord(
                        helperId,
                        `
                            import { request } from '@datadog/action-catalog/http/http';
                            import { HTTP_CONNECTION_ID } from './one.js';
                            request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                        `,
                        [actionCatalogId, oneId],
                    ),
                    createRecord(oneId, "export * from './two.js';", [twoId]),
                    createRecord(twoId, "export * from './one.js';", [oneId]),
                ];
            },
            expectedMessage: 'unsupported static definition cycle',
        },
        {
            description: 'default imports',
            records: () => {
                const helperId = '/project/src/backend/helpers/http.js';
                const idsId = '/project/src/backend/helpers/ids.js';
                return [
                    createRecord(entryId, "import { getEcho } from './helpers/http.js';", [
                        helperId,
                    ]),
                    createRecord(
                        helperId,
                        `
                            import { request } from '@datadog/action-catalog/http/http';
                            import HTTP_CONNECTION_ID from './ids.js';
                            request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                        `,
                        [actionCatalogId, idsId],
                    ),
                    createRecord(idsId, "export default 'conn-http';"),
                ];
            },
            expectedMessage: 'unsupported static definition default-import',
        },
        {
            description: 'namespace imports',
            records: () => {
                const helperId = '/project/src/backend/helpers/http.js';
                const idsId = '/project/src/backend/helpers/ids.js';
                return [
                    createRecord(entryId, "import { getEcho } from './helpers/http.js';", [
                        helperId,
                    ]),
                    createRecord(
                        helperId,
                        `
                            import { request } from '@datadog/action-catalog/http/http';
                            import * as ids from './ids.js';
                            request({ connectionId: ids.HTTP_CONNECTION_ID, inputs: {} });
                        `,
                        [actionCatalogId, idsId],
                    ),
                    createRecord(idsId, "export const HTTP_CONNECTION_ID = 'conn-http';"),
                ];
            },
            expectedMessage: 'unsupported static definition namespace-import',
        },
        {
            description: 'mutable exports',
            records: () => {
                const helperId = '/project/src/backend/helpers/http.js';
                const idsId = '/project/src/backend/helpers/ids.js';
                return [
                    createRecord(entryId, "import { getEcho } from './helpers/http.js';", [
                        helperId,
                    ]),
                    createRecord(
                        helperId,
                        `
                            import { request } from '@datadog/action-catalog/http/http';
                            import { HTTP_CONNECTION_ID } from './ids.js';
                            request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                        `,
                        [actionCatalogId, idsId],
                    ),
                    createRecord(idsId, "export let HTTP_CONNECTION_ID = 'conn-http';"),
                ];
            },
            expectedMessage: 'unsupported static definition mutable-binding',
        },
        {
            description: 'reassigned exports',
            records: () => {
                const helperId = '/project/src/backend/helpers/http.js';
                const idsId = '/project/src/backend/helpers/ids.js';
                return [
                    createRecord(entryId, "import { getEcho } from './helpers/http.js';", [
                        helperId,
                    ]),
                    createRecord(
                        helperId,
                        `
                            import { request } from '@datadog/action-catalog/http/http';
                            import { HTTP_CONNECTION_ID } from './ids.js';
                            request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                        `,
                        [actionCatalogId, idsId],
                    ),
                    createRecord(
                        idsId,
                        `
                            export const HTTP_CONNECTION_ID = 'conn-http';
                            HTTP_CONNECTION_ID = 'conn-other';
                        `,
                    ),
                ];
            },
            expectedMessage: 'unsupported static definition unsupported-binding',
        },
        {
            description: 'unsupported exported bindings',
            records: () => {
                const helperId = '/project/src/backend/helpers/http.js';
                const idsId = '/project/src/backend/helpers/ids.js';
                return [
                    createRecord(entryId, "import { getEcho } from './helpers/http.js';", [
                        helperId,
                    ]),
                    createRecord(
                        helperId,
                        `
                            import { request } from '@datadog/action-catalog/http/http';
                            import { getConnectionId } from './ids.js';
                            request({ connectionId: getConnectionId, inputs: {} });
                        `,
                        [actionCatalogId, idsId],
                    ),
                    createRecord(
                        idsId,
                        `
                            export function getConnectionId() {
                                return 'conn-http';
                            }
                        `,
                    ),
                ];
            },
            expectedMessage: 'unsupported static definition unsupported-binding',
        },
    ])(
        'Should fail closed for imported connection ID $description',
        ({ records, expectedMessage }) => {
            expect(() => extract(records())).toThrow(expectedMessage);
        },
    );

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
