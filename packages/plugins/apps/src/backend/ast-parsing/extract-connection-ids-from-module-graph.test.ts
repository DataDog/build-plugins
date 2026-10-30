// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { createFixtureRecord } from '@dd/tests/_jest/helpers/moduleGraph';
import type { Program } from 'estree';
import { parseAst } from 'rollup/parseAst';

import { extractConnectionIdsFromModuleGraph } from './extract-connection-ids-from-module-graph';
import { createParsedModuleRecord, type ParsedModuleRecord } from './module-graph';
import { collectMutatedImportedObjectVariables } from './static-string-resolution';

jest.mock('./static-string-resolution', () => {
    const actual = jest.requireActual<typeof import('./static-string-resolution')>(
        './static-string-resolution',
    );
    return {
        ...actual,
        collectMutatedImportedObjectVariables: jest.fn(
            actual.collectMutatedImportedObjectVariables,
        ),
    };
});

const collectMutatedMock = jest.mocked(collectMutatedImportedObjectVariables);

const buildRoot = '/project';
const entryId = '/project/src/backend/actions.backend.js';

function parse(code: string): Program {
    return parseAst(code) as Program;
}

const createRecord = (id: string, code: string, resolvedIds: string[] = []): ParsedModuleRecord =>
    createFixtureRecord(id, buildRoot, code, resolvedIds);

function extract(records: ParsedModuleRecord[]): string[] {
    return extractConnectionIdsFromModuleGraph(
        entryId,
        new Map(records.map((record) => [record.id, record])),
        buildRoot,
    );
}

describe('Backend Functions - extractConnectionIdsFromModuleGraph', () => {
    test('Should return null when creating records for modules outside the backend graph', () => {
        const ast = parse('export const value = true;');
        const record = createParsedModuleRecord(
            '/project/node_modules/package/index.js',
            buildRoot,
            ast,
            [],
        );
        expect(record).toBeNull();
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
            ['@datadog/action-catalog/http/http'],
        );

        expect(extract([entry, helper])).toEqual(['conn-helper']);
    });

    test('Should extract a declared empty-string connection ID rather than treating it as absent', () => {
        const entry = createRecord(
            entryId,
            `
                import { request } from '@datadog/action-catalog/http/http';

                export function run() {
                    return request({ connectionId: '', inputs: {} });
                }
            `,
            ['@datadog/action-catalog/http/http'],
        );

        expect(extract([entry])).toEqual(['']);
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
            ['@datadog/action-catalog/http/http'],
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
            [idsId, '@datadog/action-catalog/http/http'],
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
            [idsId, '@datadog/action-catalog/http/http'],
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
            [idsId, '@datadog/action-catalog/http/http'],
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
            [indexId, '@datadog/action-catalog/http/http'],
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
            ['@datadog/action-catalog/http/http'],
        );
        const star = createRecord(
            starId,
            `
                import { request } from '@datadog/action-catalog/http/http';
                export function getStar() {
                    return request({ connectionId: 'conn-star', inputs: {} });
                }
            `,
            ['@datadog/action-catalog/http/http'],
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
            ['@datadog/action-catalog/http/http'],
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
            [bId, '@datadog/action-catalog/http/http'],
        );
        const b = createRecord(
            bId,
            `
                import './a.js';
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: 'conn-b', inputs: {} });
            `,
            [aId, '@datadog/action-catalog/http/http'],
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
            [idsId, '@datadog/action-catalog/http/http'],
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
                [...dependencies, '@datadog/action-catalog/http/http'],
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
            ['@datadog/action-catalog/http/http'],
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
            ['@datadog/action-catalog/http/http'],
        );

        expect(extract([entry, helper])).toEqual(['conn-ts']);
    });

    const ACTION_CATALOG_HTTP = '@datadog/action-catalog/http/http';
    const LONG_ALIAS_CHAIN = Array.from({ length: 3000 }, (_, i) => `let a${i + 1} = a${i};`).join(
        ' ',
    );

    const createObjectConnectionIdEntry = (statements: string, connectionId = 'CONN.github') =>
        createRecord(
            entryId,
            `
                import { request } from '${ACTION_CATALOG_HTTP}';

                const CONN = {
                    github: 'conn-github',
                    gh: { id: 'conn-gh' },
                    ready: Promise.resolve({}),
                    someMethod() { return 1; },
                };
                ${statements}

                export function run() {
                    return request({ connectionId: ${connectionId}, inputs: {} });
                }
            `,
            [ACTION_CATALOG_HTTP],
        );

    test.each([
        { description: 'Object.assign', statements: "Object.assign(CONN, { github: 'other' });" },
        {
            description: 'Object.defineProperty',
            statements: "Object.defineProperty(CONN, 'github', { value: 'other' });",
        },
        {
            description: 'Object.defineProperties',
            statements: "Object.defineProperties(CONN, { github: { value: 'other' } });",
        },
        { description: 'Object.setPrototypeOf', statements: 'Object.setPrototypeOf(CONN, null);' },
        { description: 'Reflect.set', statements: "Reflect.set(CONN, 'github', 'other');" },
        {
            description: 'Reflect.defineProperty',
            statements: "Reflect.defineProperty(CONN, 'github', { value: 'other' });",
        },
        {
            description: 'Reflect.deleteProperty',
            statements: "Reflect.deleteProperty(CONN, 'github');",
        },
        {
            description: 'Reflect.set with a spread where the receiver would be',
            statements: "const extra = []; Reflect.set(CONN, 'github', 'other', ...extra);",
        },
        {
            description: 'Object.assign called with a computed key',
            statements: "Object['assign'](CONN, { github: 'other' });",
        },
        {
            description: 'Object.assign called with a template-literal computed key',
            statements: "Object[`assign`](CONN, { github: 'other' });",
        },
        {
            description: 'Object.assign called with a const-aliased computed key',
            statements: "const method = 'assign'; Object[method](CONN, { github: 'other' });",
        },
        {
            description: 'Reflect.setPrototypeOf',
            statements: 'Reflect.setPrototypeOf(CONN, null);',
        },
        {
            description: 'Object.assign on one of its members',
            statements: "Object.assign(CONN.gh, { id: 'other' });",
            connectionId: 'CONN.gh.id',
        },
        {
            description: 'a write through an alias',
            statements: "const alias = CONN; alias.github = 'other';",
        },
        {
            description: 'a write through an alias of one of its members',
            statements: "const gh = CONN.gh; gh.id = 'other';",
            connectionId: 'CONN.gh.id',
        },
        {
            description: 'a write through an alias declared in a function',
            statements: "function rename() { const alias = CONN; alias.github = 'other'; }",
        },
        {
            description: 'a write through a destructured member alias',
            statements: "const { gh } = CONN; gh.id = 'other';",
            connectionId: 'CONN.gh.id',
        },
        {
            description: 'a write through an alias assigned after its declaration',
            statements: "let gh; gh = CONN.gh; gh.id = 'other';",
            connectionId: 'CONN.gh.id',
        },
        {
            description: 'Reflect.set with it as the receiver',
            statements: "Reflect.set({}, 'github', 'other', CONN);",
        },
        {
            description: 'a write through an optional-chaining alias',
            statements: "const gh = CONN?.gh; gh.id = 'other';",
            connectionId: 'CONN.gh.id',
        },
        {
            description: 'a write through an alias with a fallback',
            statements: "const gh = CONN.gh || {}; gh.id = 'other';",
            connectionId: 'CONN.gh.id',
        },
        {
            description: 'a write through a conditional alias',
            statements: "const gh = Math.random() > 0.5 ? CONN.gh : null; gh.id = 'other';",
            connectionId: 'CONN.gh.id',
        },
        {
            description: 'a write through a chained-assignment alias',
            statements: "let a, b; a = b = CONN; a.github = 'other';",
        },
        {
            description: 'a write to a member of a rest copy',
            statements: "const { github, ...rest } = CONN; rest.gh.id = 'other';",
            connectionId: 'CONN.gh.id',
        },
        {
            description: 'a write through a destructured member of a rest copy',
            statements: "const { github, ...rest } = CONN; const { gh } = rest; gh.id = 'other';",
            connectionId: 'CONN.gh.id',
        },
        {
            description: 'a write at the end of a long alias chain',
            statements: `let a0 = CONN; ${LONG_ALIAS_CHAIN} a3000.github = 'other';`,
        },
        {
            description: 'a write through a ||= alias',
            statements: "let cur = CONN.gh; (cur ||= {}).id = 'other';",
            connectionId: 'CONN.gh.id',
        },
        {
            description: 'a write through a ??= alias',
            statements: "let cur = CONN.gh; const gh = (cur ??= {}); gh.id = 'other';",
            connectionId: 'CONN.gh.id',
        },
        {
            description: 'a write to a member of a fallback expression',
            statements: "(CONN.gh || {}).id = 'other';",
            connectionId: 'CONN.gh.id',
        },
        {
            description: 'Object.assign on an alias',
            statements: "const alias = CONN; Object.assign(alias, { github: 'other' });",
        },
    ])(
        'Should fail closed for an object connection ID mutated by $description',
        ({ statements, connectionId }) => {
            const entry = createObjectConnectionIdEntry(statements, connectionId);

            expect(() => extract([entry])).toThrow('mutated object binding');
        },
    );

    test.each([
        { description: 'logged', statements: 'console.log(CONN);' },
        { description: 'passed to Object.keys', statements: 'Object.keys(CONN);' },
        { description: 'passed to JSON.stringify', statements: 'JSON.stringify(CONN);' },
        { description: 'copied by Object.assign', statements: 'Object.assign({}, CONN);' },
        { description: 'aliased without a write', statements: 'const alias = CONN;' },
        {
            description: 'read through an unwritten alias',
            statements: 'const alias = CONN;',
            connectionId: 'alias.github',
        },
        { description: 'used to call one of its methods', statements: 'CONN.someMethod();' },
        {
            description: 'assigned to an alias that is never written',
            statements: 'let gh; gh = CONN.gh;',
        },
        {
            description: 'destructured into a rest copy that is written',
            statements: 'const { gh, ...rest } = CONN; rest.extra = 1;',
        },
        {
            description: 'passed to a local function named Object',
            statements: 'function copy(Object) { Object.assign(CONN, {}); }',
        },
        {
            description: 'holding a promise whose resolved value is written',
            statements: 'async function load() { const result = await CONN.ready; result.x = 1; }',
        },
        {
            description: 'passed to Reflect.set as the target with another receiver',
            statements: "const OTHER = {}; Reflect.set(CONN, 'github', 'other', OTHER);",
        },
        {
            description: 'guarding a write to another object with &&',
            statements: 'const OTHER = {}; const target = CONN.gh && OTHER; target.y = 2;',
        },
    ])(
        'Should still resolve an unmutated object connection ID $description',
        ({ statements, connectionId }) => {
            const entry = createObjectConnectionIdEntry(statements, connectionId);

            expect(extract([entry])).toEqual(['conn-github']);
        },
    );

    const CONNECTIONS_ID = '/project/src/backend/connections.js';
    const CONNECTIONS_CODE = `
        export const CONN = { github: 'conn-github', gh: { id: 'conn-gh' } };
        export const ALIAS = CONN;
        export let MUTABLE_ALIAS = CONN.gh;
        export const { gh: DESTRUCTURED_ALIAS } = CONN;
        export const { github: GITHUB_ID, ...REST } = CONN;
    `;

    const extractWithImportedConnections = (statements: string, connectionId = 'CONN.github') => {
        const entry = createRecord(
            entryId,
            `
                import { request } from '${ACTION_CATALOG_HTTP}';
                import {
                    CONN,
                    ALIAS,
                    MUTABLE_ALIAS,
                    DESTRUCTURED_ALIAS,
                    REST,
                } from './connections.js';

                ${statements}

                export function run() {
                    return request({ connectionId: ${connectionId}, inputs: {} });
                }
            `,
            [ACTION_CATALOG_HTTP, CONNECTIONS_ID],
        );
        const connections = createRecord(CONNECTIONS_ID, CONNECTIONS_CODE);
        return extract([entry, connections]);
    };

    test.each([
        { description: 'Object.assign', statements: "Object.assign(CONN, { github: 'other' });" },
        {
            description: 'Reflect.set with it as the receiver',
            statements: "Reflect.set({}, 'github', 'other', CONN);",
        },
        {
            description: 'a write through an alias its module exports',
            statements: "ALIAS.github = 'other';",
        },
        {
            description: 'a write through a let alias its module exports',
            statements: "MUTABLE_ALIAS.id = 'other';",
            connectionId: 'CONN.gh.id',
        },
        {
            description: 'a write through a destructured alias its module exports',
            statements: "DESTRUCTURED_ALIAS.id = 'other';",
            connectionId: 'CONN.gh.id',
        },
        {
            description: 'a write to a member of a rest copy',
            statements: "const { github, ...rest } = CONN; rest.gh.id = 'other';",
            connectionId: 'CONN.gh.id',
        },
        {
            description: 'a write through a destructured member of a rest copy',
            statements: "const { github, ...rest } = CONN; const { gh } = rest; gh.id = 'other';",
            connectionId: 'CONN.gh.id',
        },
        {
            description: 'a write at the end of a long alias chain',
            statements: `let a0 = CONN; ${LONG_ALIAS_CHAIN} a3000.github = 'other';`,
        },
        {
            description: 'a write through an alias assigned after its declaration',
            statements: "let gh; gh = CONN.gh; gh.id = 'other';",
            connectionId: 'CONN.gh.id',
        },
    ])(
        'Should fail closed for an imported object connection ID mutated by $description',
        ({ statements, connectionId }) => {
            expect(() => extractWithImportedConnections(statements, connectionId)).toThrow(
                'imported-object-mutation',
            );
        },
    );

    test.each([
        { description: 'read directly', statements: '' },
        {
            description: 'read through its exported alias',
            statements: '',
            connectionId: 'ALIAS.github',
        },
        {
            description: 'assigned to an alias that is never written',
            statements: 'let gh; gh = CONN.gh;',
        },
        { description: 'copied by Object.assign', statements: 'Object.assign({}, CONN);' },
        { description: 'copied by a rest export that is written', statements: 'REST.extra = 1;' },
        {
            description: 'passed to a local function named Reflect',
            statements: "function copy(Reflect) { Reflect.set(CONN, 'github', 'other'); }",
        },
    ])(
        'Should still resolve an unmutated imported object connection ID $description',
        ({ statements, connectionId }) => {
            expect(extractWithImportedConnections(statements, connectionId)).toEqual([
                'conn-github',
            ]);
        },
    );

    test('Should still resolve a local object that shares its name with a namespace re-export written elsewhere', () => {
        const otherId = '/project/src/backend/other.js';
        const entry = createRecord(
            entryId,
            `
                import { CONN as NAMESPACE } from './connections.js';

                Reflect.set(NAMESPACE, 'github', 'other');

                export function run() {}
            `,
            [CONNECTIONS_ID],
        );
        const connections = createRecord(
            CONNECTIONS_ID,
            `
                import { request } from '${ACTION_CATALOG_HTTP}';

                export * as CONN from './other.js';
                const CONN = { github: 'conn-github' };

                request({ connectionId: CONN.github, inputs: {} });
            `,
            [ACTION_CATALOG_HTTP, otherId],
        );
        const other = createRecord(otherId, 'export const value = 1;');

        expect(extract([entry, connections, other])).toEqual(['conn-github']);
    });

    test.each([
        { description: 'a null __proto__', property: '__proto__: null' },
        { description: 'a shorthand __proto__ property', property: '__proto__' },
    ])(
        'Should still extract the connection ID of call options with $description',
        ({ property }) => {
            const entry = createRecord(
                entryId,
                `
                import { request } from '${ACTION_CATALOG_HTTP}';

                const __proto__ = {};

                export function run() {
                    return request({ connectionId: 'conn-a', ${property}, inputs: {} });
                }
            `,
                [ACTION_CATALOG_HTTP],
            );

            expect(extract([entry])).toEqual(['conn-a']);
        },
    );

    test.each([
        { description: 'a __proto__ key', property: "__proto__: { connectionId: 'hidden' }" },
        {
            description: 'a quoted __proto__ key',
            property: "'__proto__': { connectionId: 'hidden' }",
        },
        { description: 'a toJSON method', property: "toJSON() { return { connectionId: 'b' }; }" },
        { description: 'a then method', property: 'then(resolve) { resolve({}); }' },
        { description: 'a shorthand toJSON property', property: 'toJSON' },
    ])('Should fail closed for action-catalog call options with $description', ({ property }) => {
        const entry = createRecord(
            entryId,
            `
                import { request } from '${ACTION_CATALOG_HTTP}';

                export function run() {
                    return request({ connectionId: 'conn-a', ${property}, inputs: {} });
                }
            `,
            [ACTION_CATALOG_HTTP],
        );

        expect(() => extract([entry])).toThrow('could hide a connectionId');
    });

    test.each([
        {
            description: 'several connectionId call sites',
            connectionIds: ['a', 'b', 'c'],
            walks: 1,
        },
        { description: 'no connectionId call site', connectionIds: [], walks: 0 },
    ])(
        'Should walk the module graph for object writes $walks time(s) per extraction with $description',
        ({ connectionIds, walks }) => {
            const calls = connectionIds.map(
                (id) => `request({ connectionId: CONN.${id}, inputs: {} });`,
            );
            const entry = createRecord(
                entryId,
                `
                import { request } from '${ACTION_CATALOG_HTTP}';
                const CONN = { a: 'conn-a', b: 'conn-b', c: 'conn-c' };

                export function run() {
                    request({ inputs: {} });
                    ${calls.join('\n')}
                }
            `,
                [ACTION_CATALOG_HTTP],
            );
            collectMutatedMock.mockClear();

            const extracted = extract([entry]);

            const expected = connectionIds.map((id) => `conn-${id}`);
            expect(extracted).toEqual(expected);
            expect(collectMutatedMock).toHaveBeenCalledTimes(walks);
        },
    );
});
