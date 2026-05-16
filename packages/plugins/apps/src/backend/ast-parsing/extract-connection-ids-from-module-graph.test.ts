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

    test('Should resolve imported connection ID string values inside reachable helpers', () => {
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
                import { HTTP_CONNECTION_ID, TEMPLATE_CONNECTION_ID } from './ids.js';
                import { request } from '@datadog/action-catalog/http/http';

                export function getEcho() {
                    request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                    request({ connectionId: TEMPLATE_CONNECTION_ID, inputs: {} });
                }
            `,
            [idsId],
        );
        const ids = createRecord(
            idsId,
            `
                export const HTTP_CONNECTION_ID = 'conn-imported';
                export const TEMPLATE_CONNECTION_ID = \`conn-template\`;
            `,
        );

        expect(extract([entry, helper, ids])).toEqual(['conn-imported', 'conn-template']);
    });

    test('Should resolve imported connection ID const chains in the definition module context', () => {
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
                import { HTTP_CONNECTION_ID } from './ids.js';
                import { request } from '@datadog/action-catalog/http/http';

                const BASE_CONNECTION_ID = 'wrong-module';

                export function getEcho() {
                    return request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                }
            `,
            [idsId],
        );
        const ids = createRecord(
            idsId,
            `
                const BASE_CONNECTION_ID = 'conn-chain';
                export const HTTP_CONNECTION_ID = BASE_CONNECTION_ID;
            `,
        );

        expect(extract([entry, helper, ids])).toEqual(['conn-chain']);
    });

    test('Should resolve imported connection ID object values inside reachable helpers', () => {
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
                import { CONNECTIONS } from './ids.js';
                import { request } from '@datadog/action-catalog/http/http';

                export function getEcho() {
                    request({ connectionId: CONNECTIONS.HTTP, inputs: {} });
                    request({ connectionId: CONNECTIONS.NESTED.PROD, inputs: {} });
                }
            `,
            [idsId],
        );
        const ids = createRecord(
            idsId,
            `
                const PROD_CONNECTION_ID = 'conn-prod';
                export const CONNECTIONS = {
                    HTTP: 'conn-http',
                    NESTED: {
                        PROD: PROD_CONNECTION_ID,
                    },
                };
            `,
        );

        expect(extract([entry, helper, ids])).toEqual(['conn-http', 'conn-prod']);
    });

    test('Should resolve imported connection IDs through aliases and re-exports', () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const localId = '/project/src/backend/helpers/local.js';
        const idsId = '/project/src/backend/helpers/ids.js';
        const relayId = '/project/src/backend/helpers/relay.js';
        const starId = '/project/src/backend/helpers/star.js';
        const indexId = '/project/src/backend/helpers/index.js';
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
                import {
                    ALIAS_CONNECTION_ID,
                    RELAY_CONNECTION_ID,
                    STAR_CONNECTION_ID,
                } from './index.js';
                import { request } from '@datadog/action-catalog/http/http';

                export function getEcho() {
                    request({ connectionId: ALIAS_CONNECTION_ID, inputs: {} });
                    request({ connectionId: RELAY_CONNECTION_ID, inputs: {} });
                    request({ connectionId: STAR_CONNECTION_ID, inputs: {} });
                }
            `,
            [indexId],
        );
        const local = createRecord(
            localId,
            `
                const HTTP_CONNECTION_ID = 'conn-alias';
                export { HTTP_CONNECTION_ID as ALIAS_CONNECTION_ID };
            `,
        );
        const ids = createRecord(idsId, "export const HTTP_CONNECTION_ID = 'conn-relay';");
        const relay = createRecord(
            relayId,
            `
                import { HTTP_CONNECTION_ID } from './ids.js';
                export { HTTP_CONNECTION_ID as RELAY_CONNECTION_ID };
            `,
            [idsId],
        );
        const star = createRecord(starId, "export const STAR_CONNECTION_ID = 'conn-star';");
        const index = createRecord(
            indexId,
            `
                export { ALIAS_CONNECTION_ID } from './local.js';
                export { RELAY_CONNECTION_ID } from './relay.js';
                export * from './star.js';
            `,
            [localId, relayId, starId],
        );

        expect(extract([entry, helper, index, local, relay, ids, star])).toEqual([
            'conn-alias',
            'conn-relay',
            'conn-star',
        ]);
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

    test('Should fail closed for uncollected imported connection ID source modules', () => {
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
                import { HTTP_CONNECTION_ID } from './ids.js';
                import { request } from '@datadog/action-catalog/http/http';

                export function getEcho() {
                    return request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                }
            `,
            [idsId],
        );

        expect(() => extract([entry, helper])).toThrow(
            'static string resolution static-definition-unsupported',
        );
    });

    test('Should fail closed for unsupported imported connection ID values', () => {
        const cases = [
            {
                description: 'ambiguous star exports',
                helperImport: "import { HTTP_CONNECTION_ID } from './index.js';",
                connectionId: 'HTTP_CONNECTION_ID',
                records: () => {
                    const oneId = '/project/src/backend/helpers/one.js';
                    const twoId = '/project/src/backend/helpers/two.js';
                    const indexId = '/project/src/backend/helpers/index.js';
                    return {
                        dependencies: [indexId],
                        records: [
                            createRecord(oneId, "export const HTTP_CONNECTION_ID = 'conn-one';"),
                            createRecord(twoId, "export const HTTP_CONNECTION_ID = 'conn-two';"),
                            createRecord(
                                indexId,
                                `
                                    export * from './one.js';
                                    export * from './two.js';
                                `,
                                [oneId, twoId],
                            ),
                        ],
                        message: 'ambiguous-star-export',
                    };
                },
            },
            {
                description: 'missing exports',
                helperImport: "import { HTTP_CONNECTION_ID } from './ids.js';",
                connectionId: 'HTTP_CONNECTION_ID',
                records: () => {
                    const idsId = '/project/src/backend/helpers/ids.js';
                    return {
                        dependencies: [idsId],
                        records: [
                            createRecord(idsId, "export const OTHER_CONNECTION_ID = 'conn-http';"),
                        ],
                        message: 'missing-export',
                    };
                },
            },
            {
                description: 'mutable exports',
                helperImport: "import { HTTP_CONNECTION_ID } from './ids.js';",
                connectionId: 'HTTP_CONNECTION_ID',
                records: () => {
                    const idsId = '/project/src/backend/helpers/ids.js';
                    return {
                        dependencies: [idsId],
                        records: [
                            createRecord(idsId, "export let HTTP_CONNECTION_ID = 'conn-http';"),
                        ],
                        message: 'mutable-binding',
                    };
                },
            },
            {
                description: 'reassigned exported bindings',
                helperImport: "import { HTTP_CONNECTION_ID } from './ids.js';",
                connectionId: 'HTTP_CONNECTION_ID',
                records: () => {
                    const idsId = '/project/src/backend/helpers/ids.js';
                    return {
                        dependencies: [idsId],
                        records: [
                            createRecord(
                                idsId,
                                `
                                    export const HTTP_CONNECTION_ID = 'conn-http';
                                    HTTP_CONNECTION_ID = 'conn-reassigned';
                                `,
                            ),
                        ],
                        message: 'unsupported-binding',
                    };
                },
            },
            {
                description: 'export cycles',
                helperImport: "import { HTTP_CONNECTION_ID } from './one.js';",
                connectionId: 'HTTP_CONNECTION_ID',
                records: () => {
                    const oneId = '/project/src/backend/helpers/one.js';
                    const twoId = '/project/src/backend/helpers/two.js';
                    return {
                        dependencies: [oneId],
                        records: [
                            createRecord(oneId, "export * from './two.js';", [twoId]),
                            createRecord(twoId, "export * from './one.js';", [oneId]),
                        ],
                        message: 'cycle',
                    };
                },
            },
            {
                description: 'default imports',
                helperImport: "import HTTP_CONNECTION_ID from './ids.js';",
                connectionId: 'HTTP_CONNECTION_ID',
                records: () => {
                    const idsId = '/project/src/backend/helpers/ids.js';
                    return {
                        dependencies: [idsId],
                        records: [
                            createRecord(idsId, "export const HTTP_CONNECTION_ID = 'conn-http';"),
                        ],
                        message: 'default-import',
                    };
                },
            },
            {
                description: 'namespace imports',
                helperImport: "import * as ids from './ids.js';",
                connectionId: 'ids.HTTP_CONNECTION_ID',
                records: () => {
                    const idsId = '/project/src/backend/helpers/ids.js';
                    return {
                        dependencies: [idsId],
                        records: [
                            createRecord(idsId, "export const HTTP_CONNECTION_ID = 'conn-http';"),
                        ],
                        message: 'namespace-import',
                    };
                },
            },
        ];

        for (const { helperImport, connectionId, records } of cases) {
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
            const { dependencies, records: dependencyRecords, message } = records();
            const helper = createRecord(
                helperId,
                `
                    ${helperImport}
                    import { request } from '@datadog/action-catalog/http/http';

                    export function getEcho() {
                        return request({ connectionId: ${connectionId}, inputs: {} });
                    }
                `,
                dependencies,
            );

            expect(() => extract([entry, helper, ...dependencyRecords])).toThrow(message);
        }
    });

    test('Should fail closed when static string resolution rejects dynamic expressions', () => {
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

                function getConnectionId() {
                    return 'conn-http';
                }

                export function getEcho() {
                    return request({ connectionId: getConnectionId(), inputs: {} });
                }
            `,
        );

        expect(() => extract([entry, helper])).toThrow('unsupported-expression');
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
