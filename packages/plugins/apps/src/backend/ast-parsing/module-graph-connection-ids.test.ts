// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Program } from 'estree';
import path from 'path';
import { parseAst } from 'rollup/parseAst';
import { transformWithEsbuild } from 'vite';

import {
    extractConnectionIdsFromModuleGraph,
    type ConnectionIdModuleGraphContext,
} from './module-graph-connection-ids';

const buildRoot = '/project';
const entryId = '/project/src/backend/actions.backend.js';

function parse(code: string): Program {
    return parseAst(code) as Program;
}

function createContext(modules: Map<string, string>): ConnectionIdModuleGraphContext & {
    resolve: jest.MockedFunction<ConnectionIdModuleGraphContext['resolve']>;
    load: jest.MockedFunction<NonNullable<ConnectionIdModuleGraphContext['load']>>;
    addWatchFile: jest.Mock;
} {
    const resolve: ConnectionIdModuleGraphContext['resolve'] = async (specifier, importer) => {
        const resolvedPath = specifier.startsWith('/')
            ? specifier
            : path.resolve(path.dirname(importer), specifier);

        if (modules.has(resolvedPath)) {
            return { id: resolvedPath };
        }

        for (const extension of ['.js', '.ts', '.tsx', '.jsx']) {
            const resolvedWithExtension = `${resolvedPath}${extension}`;
            if (modules.has(resolvedWithExtension)) {
                return { id: resolvedWithExtension };
            }
        }

        return null;
    };

    return {
        buildRoot,
        parse,
        resolve: jest.fn(resolve),
        load: jest.fn(async (id) => ({ code: modules.get(id) ?? null })),
        transformWithEsbuild,
        addWatchFile: jest.fn(),
    };
}

describe('Backend Functions - extractConnectionIdsFromModuleGraph', () => {
    test('Should extract inline connection IDs from statically reachable helper modules', async () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const context = createContext(
            new Map([
                [
                    helperId,
                    `
                        import { request } from '@datadog/action-catalog/http/http';

                        export function getEcho() {
                            return request({ connectionId: 'conn-helper', inputs: {} });
                        }
                    `,
                ],
            ]),
        );
        const ast = parse(`
            import { getEcho } from './helpers/http.js';

            export function run() {
                return getEcho();
            }
        `);

        await expect(extractConnectionIdsFromModuleGraph(ast, entryId, context)).resolves.toEqual([
            'conn-helper',
        ]);
        expect(context.resolve).toHaveBeenCalledWith('./helpers/http.js', entryId);
        expect(context.load).toHaveBeenCalledWith(helperId);
        expect(context.addWatchFile).toHaveBeenCalledWith(helperId);
    });

    test('Should resolve same-module connection ID values inside reachable helpers', async () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const context = createContext(
            new Map([
                [
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
                ],
            ]),
        );
        const ast = parse(`
            import { getEcho } from './helpers/http.js';

            export function run() {
                return getEcho();
            }
        `);

        await expect(extractConnectionIdsFromModuleGraph(ast, entryId, context)).resolves.toEqual([
            'conn-const',
            'conn-object',
        ]);
    });

    test('Should traverse named re-exports and export star declarations', async () => {
        const barrelId = '/project/src/backend/helpers/index.js';
        const namedId = '/project/src/backend/helpers/named.js';
        const starId = '/project/src/backend/helpers/star.js';
        const context = createContext(
            new Map([
                [
                    barrelId,
                    `
                        export { getNamed } from './named.js';
                        export * from './star.js';
                    `,
                ],
                [
                    namedId,
                    `
                        import { request } from '@datadog/action-catalog/http/http';
                        export function getNamed() {
                            return request({ connectionId: 'conn-named', inputs: {} });
                        }
                    `,
                ],
                [
                    starId,
                    `
                        import { request } from '@datadog/action-catalog/http/http';
                        export function getStar() {
                            return request({ connectionId: 'conn-star', inputs: {} });
                        }
                    `,
                ],
            ]),
        );
        const ast = parse(`
            import './helpers/index.js';

            export function run() {}
        `);

        await expect(extractConnectionIdsFromModuleGraph(ast, entryId, context)).resolves.toEqual([
            'conn-named',
            'conn-star',
        ]);
    });

    test('Should ignore type-only imports and package imports while building the graph', async () => {
        const context = createContext(new Map());
        const ast = parse(`
            import { typeOnly } from './types.js';
            import { helper } from 'some-package';

            export function run() {}
        `);
        (ast.body[0] as unknown as { importKind: string }).importKind = 'type';

        await expect(extractConnectionIdsFromModuleGraph(ast, entryId, context)).resolves.toEqual(
            [],
        );
        expect(context.resolve).not.toHaveBeenCalled();
    });

    test('Should skip resolved files outside the local source graph', async () => {
        const skippedId = '/project/src/backend/node_modules/helper.js';
        const context = createContext(new Map([[skippedId, 'throw new Error("unloaded");']]));
        const ast = parse(`
            import './node_modules/helper.js';

            export function run() {}
        `);

        await expect(extractConnectionIdsFromModuleGraph(ast, entryId, context)).resolves.toEqual(
            [],
        );
        expect(context.resolve).toHaveBeenCalledWith('./node_modules/helper.js', entryId);
        expect(context.load).not.toHaveBeenCalledWith(skippedId);
    });

    test.each([
        { description: 'outside buildRoot', resolvedId: '/external/helper.js' },
        { description: 'virtual modules', resolvedId: '\0virtual-helper.js' },
        { description: 'dist output', resolvedId: '/project/dist/helper.js' },
        { description: 'build output', resolvedId: '/project/build/helper.js' },
        { description: 'Vite cache output', resolvedId: '/project/.vite/helper.js' },
    ])('Should skip $description', async ({ resolvedId }) => {
        const context = createContext(new Map([[resolvedId, 'throw new Error("unloaded");']]));
        context.resolve.mockResolvedValue({ id: resolvedId });
        const ast = parse(`
            import './helper.js';

            export function run() {}
        `);

        await expect(extractConnectionIdsFromModuleGraph(ast, entryId, context)).resolves.toEqual(
            [],
        );
        expect(context.load).not.toHaveBeenCalledWith(resolvedId);
    });

    test('Should protect against local graph cycles', async () => {
        const aId = '/project/src/backend/a.js';
        const bId = '/project/src/backend/b.js';
        const context = createContext(
            new Map([
                [
                    aId,
                    `
                        import './b.js';
                        import { request } from '@datadog/action-catalog/http/http';
                        request({ connectionId: 'conn-a', inputs: {} });
                    `,
                ],
                [
                    bId,
                    `
                        import './a.js';
                        import { request } from '@datadog/action-catalog/http/http';
                        request({ connectionId: 'conn-b', inputs: {} });
                    `,
                ],
            ]),
        );
        const ast = parse(`
            import './a.js';

            export function run() {}
        `);

        await expect(extractConnectionIdsFromModuleGraph(ast, entryId, context)).resolves.toEqual([
            'conn-a',
            'conn-b',
        ]);
        expect(context.load).toHaveBeenCalledTimes(2);
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
    ])('Should fail closed for $description', async ({ code, message }) => {
        const context = createContext(new Map());
        const ast = parse(`
            ${code}

            export function run() {}
        `);

        await expect(extractConnectionIdsFromModuleGraph(ast, entryId, context)).rejects.toThrow(
            message,
        );
    });

    test('Should fail closed for unresolved local static imports', async () => {
        const context = createContext(new Map());
        const ast = parse(`
            import './missing.js';

            export function run() {}
        `);

        await expect(extractConnectionIdsFromModuleGraph(ast, entryId, context)).rejects.toThrow(
            'unresolved local import ./missing.js',
        );
    });

    test('Should keep imported connection ID values unsupported in reachable helpers', async () => {
        const helperId = '/project/src/backend/helpers/http.js';
        const idModule = '/project/src/backend/helpers/ids.js';
        const context = createContext(
            new Map([
                [
                    helperId,
                    `
                        import { request } from '@datadog/action-catalog/http/http';
                        import { HTTP_CONNECTION_ID } from './ids.js';

                        export function getEcho() {
                            return request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                        }
                    `,
                ],
                [idModule, "export const HTTP_CONNECTION_ID = 'conn-imported';"],
            ]),
        );
        const ast = parse(`
            import { getEcho } from './helpers/http.js';

            export function run() {
                return getEcho();
            }
        `);

        await expect(extractConnectionIdsFromModuleGraph(ast, entryId, context)).rejects.toThrow(
            'imported connectionId binding HTTP_CONNECTION_ID',
        );
    });

    test('Should transform local TypeScript helpers before parsing when needed', async () => {
        const helperId = '/project/src/backend/helpers/http.ts';
        const context = createContext(
            new Map([
                [
                    helperId,
                    `
                        import { request } from '@datadog/action-catalog/http/http';

                        type Response = { ok: boolean };
                        const HTTP_CONNECTION_ID: string = 'conn-ts';

                        export function getEcho(): Response {
                            request({ connectionId: HTTP_CONNECTION_ID, inputs: {} });
                            return { ok: true };
                        }
                    `,
                ],
            ]),
        );
        const ast = parse(`
            import { getEcho } from './helpers/http';

            export function run() {
                return getEcho();
            }
        `);

        await expect(extractConnectionIdsFromModuleGraph(ast, entryId, context)).resolves.toEqual([
            'conn-ts',
        ]);
    });
});
