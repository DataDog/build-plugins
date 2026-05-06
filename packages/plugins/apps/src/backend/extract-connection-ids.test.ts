// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { extractConnectionIds } from '@dd/apps-plugin/backend/extract-connection-ids';
import { parse } from 'acorn';
import type { ExportNamedDeclaration, ImportDeclaration, Program } from 'estree';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AstNode, PluginContext } from 'rollup';

function parseModule(code: string): AstNode & Program {
    return parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        locations: true,
    }) as unknown as AstNode & Program;
}

interface TestCtxOptions {
    fallbackLoadIds?: Set<string>;
    virtualIds?: Set<string>;
}

function createCtx(files: Record<string, string>, options: TestCtxOptions = {}): PluginContext {
    const ctx = {
        parse: parseModule,
        resolve: async (source: string, importer?: string) => {
            if (options.virtualIds?.has(source)) {
                return { id: `\0${source}`, external: false };
            }
            const resolvedId = resolveSimple(source, importer, files);
            if (!resolvedId) {
                return null;
            }
            return { id: resolvedId, external: false };
        },
        load: async ({ id }: { id: string }) => {
            if (options.fallbackLoadIds?.has(id)) {
                throw new Error('[vite] The "code" property of ModuleInfo is not supported');
            }
            if (!(id in files)) {
                throw new Error(`mock load: no file ${id}`);
            }
            return { id, code: files[id], ast: null };
        },
    };
    return ctx as unknown as PluginContext;
}

function resolveSimple(
    source: string,
    importer: string | undefined,
    files: Record<string, string>,
): string | null {
    if (!importer) {
        return source in files ? source : null;
    }
    if (source.startsWith('/') && source in files) {
        return source;
    }
    if (!source.startsWith('.')) {
        return source in files ? source : null;
    }

    const base = importer.replace(/\/[^/]+$/, '');
    const candidate = path.posix.normalize(`${base}/${source}`);
    if (candidate in files) {
        return candidate;
    }
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
        if (`${candidate}${ext}` in files) {
            return `${candidate}${ext}`;
        }
    }
    return null;
}

async function extractFromGraph(
    files: Record<string, string>,
    entry = '/app/run.backend.ts',
    buildRoot = '/app',
    options?: TestCtxOptions,
): Promise<string[]> {
    const ctx = createCtx(files, options);
    return extractConnectionIds(ctx, ctx.parse(files[entry]), entry, buildRoot);
}

const CATALOG_IMPORT = `import { request } from '@datadog/action-catalog/http/http';`;

describe('Backend Functions - extractConnectionIds', () => {
    const filePath = '/project/src/backend/run.backend.ts';

    test('Should extract sorted and deduped inline string literal connectionIds from same-file calls', () => {
        const ast = parseModule(`
            import { request } from '@datadog/action-catalog/http/http';

            function helper() {
                return request({ connectionId: 'conn-b', inputs: {} });
            }

            export function run() {
                helper();
                request({ connectionId: 'conn-a', inputs: {} });
                request({ connectionId: 'conn-b', inputs: {} });
            }
        `);

        expect(extractConnectionIds(ast, filePath)).toEqual(['conn-a', 'conn-b']);
    });

    test.each([
        {
            description: 'named import from package root',
            code: `
                import { request } from '@datadog/action-catalog';
                request({ connectionId: 'named-root' });
            `,
            expected: ['named-root'],
        },
        {
            description: 'named import from package subpath',
            code: `
                import { request as httpRequest } from '@datadog/action-catalog/http/http';
                httpRequest({ connectionId: 'named-subpath' });
            `,
            expected: ['named-subpath'],
        },
        {
            description: 'default import from package subpath',
            code: `
                import request from '@datadog/action-catalog/http/http';
                request({ connectionId: 'default-subpath' });
            `,
            expected: ['default-subpath'],
        },
        {
            description: 'namespace import from package subpath',
            code: `
                import * as http from '@datadog/action-catalog/http/http';
                http.request({ connectionId: 'namespace-subpath' });
            `,
            expected: ['namespace-subpath'],
        },
    ])('Should detect action-catalog $description', ({ code, expected }) => {
        expect(extractConnectionIds(parseModule(code), filePath)).toEqual(expected);
    });

    test('Should ignore non-action-catalog calls with connectionId', () => {
        const ast = parseModule(`
            import { request } from './local-client';
            request({ connectionId: 'not-action-catalog' });
        `);

        expect(extractConnectionIds(ast, filePath)).toEqual([]);
    });

    test('Should ignore action-catalog object arguments that visibly lack connectionId', () => {
        const ast = parseModule(`
            import { request } from '@datadog/action-catalog/http/http';
            request({ inputs: { verb: 'GET' } });
        `);

        expect(extractConnectionIds(ast, filePath)).toEqual([]);
    });

    test('Should ignore type-only action-catalog imports', () => {
        const ast = parseModule(`
            import { request } from '@datadog/action-catalog/http/http';
            request({ connectionId: 'type-only' });
        `);
        (ast.body[0] as ImportDeclaration & { importKind?: string }).importKind = 'type';

        expect(extractConnectionIds(ast, filePath)).toEqual([]);
    });

    test('Should ignore type-only action-catalog import specifiers', () => {
        const ast = parseModule(`
            import { request } from '@datadog/action-catalog/http/http';
            request({ connectionId: 'type-only-specifier' });
        `);
        const importDeclaration = ast.body[0] as ImportDeclaration;
        (
            importDeclaration.specifiers[0] as ImportDeclaration['specifiers'][number] & {
                importKind?: string;
            }
        ).importKind = 'type';

        expect(extractConnectionIds(ast, filePath)).toEqual([]);
    });

    // This extractor receives the ESTree Program from Rollup's parser; TS-only
    // syntax such as `as const` is outside this helper's parser boundary.
    test.each([
        {
            description: 'same-file const string identifiers',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const CONNECTION_ID = 'same-file-const';
                request({ connectionId: CONNECTION_ID });
            `,
            expected: ['same-file-const'],
        },
        {
            description: 'exported same-file const string identifiers',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                export const CONNECTION_ID = 'exported-same-file-const';
                request({ connectionId: CONNECTION_ID });
            `,
            expected: ['exported-same-file-const'],
        },
        {
            description: 'same-file const-to-const chains',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const A = 'const-chain';
                const B = A;
                const C = B;
                request({ connectionId: C });
            `,
            expected: ['const-chain'],
        },
        {
            description: 'inline static template literals',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: \`inline-static-template\` });
            `,
            expected: ['inline-static-template'],
        },
        {
            description: 'same-file const static template literals',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const CONNECTION_ID = \`const-static-template\`;
                request({ connectionId: CONNECTION_ID });
            `,
            expected: ['const-static-template'],
        },
        {
            description: 'same-file const object members with identifier keys',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const CONNECTIONS = {
                    HTTP: 'object-identifier-key',
                };
                request({ connectionId: CONNECTIONS.HTTP });
            `,
            expected: ['object-identifier-key'],
        },
        {
            description: 'same-file const object members with string-literal keys',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const CONNECTIONS = {
                    'HTTP': 'object-string-key',
                };
                request({ connectionId: CONNECTIONS.HTTP });
            `,
            expected: ['object-string-key'],
        },
        {
            description: 'same-file const object members whose values are const identifiers',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const HTTP_CONNECTION_ID = 'object-const-value';
                const CONNECTIONS = {
                    HTTP: HTTP_CONNECTION_ID,
                };
                request({ connectionId: CONNECTIONS.HTTP });
            `,
            expected: ['object-const-value'],
        },
    ])('Should resolve $description', ({ code, expected }) => {
        expect(extractConnectionIds(parseModule(code), filePath)).toEqual(expected);
    });

    test.each([
        {
            description: 'non-object first arguments',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request(opts);
            `,
            expected: 'first argument must be an object literal',
        },
        {
            description: 'spread-composed objects',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: 'visible', ...opts });
            `,
            expected: 'object spreads can hide connectionId',
        },
        {
            description: 'computed object keys',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request({ ['connectionId']: 'computed' });
            `,
            expected: 'computed object keys can hide connectionId',
        },
        {
            description: 'optional-chain calls',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request?.({ connectionId: 'optional' });
            `,
            expected: 'optional chaining cannot be statically analyzed',
        },
        {
            description: 'action-catalog import aliases',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const action = request;
                action({ connectionId: 'alias' });
            `,
            expected: 'action-catalog call aliases cannot be statically analyzed',
        },
        {
            description: 'action-catalog namespace destructuring aliases',
            code: `
                import * as http from '@datadog/action-catalog/http/http';
                const { request: action } = http;
                action({ connectionId: 'destructured-alias' });
            `,
            expected: 'action-catalog call aliases cannot be statically analyzed',
        },
        {
            description: 'action-catalog namespace member aliases',
            code: `
                import * as http from '@datadog/action-catalog/http/http';
                const action = http.request;
                action({ connectionId: 'namespace-member-alias' });
            `,
            expected: 'action-catalog call aliases cannot be statically analyzed',
        },
        {
            description: 'computed namespace member calls',
            code: `
                import * as http from '@datadog/action-catalog/http/http';
                http['request']({ connectionId: 'computed-member' });
            `,
            expected: 'computed namespace member calls cannot be statically analyzed',
        },
    ])(
        'Should fail closed for unsupported action-catalog call shapes: $description',
        ({ code, expected }) => {
            expect(() => extractConnectionIds(parseModule(code), filePath)).toThrow(expected);
        },
    );

    test.each([
        {
            description: 'function parameters that shadow named imports',
            code: `
                import { request } from '@datadog/action-catalog/http/http';

                export function run(request) {
                    request({ connectionId: 'shadowed-param' });
                }
            `,
        },
        {
            description: 'function parameters that shadow namespace imports',
            code: `
                import * as http from '@datadog/action-catalog/http/http';

                export function run(http) {
                    http.request({ connectionId: 'shadowed-namespace-param' });
                }
            `,
        },
        {
            description: 'local aliases of shadowed parameters',
            code: `
                import { request } from '@datadog/action-catalog/http/http';

                export function run(request) {
                    const action = request;
                    action({ connectionId: 'shadowed-local-alias' });
                }
            `,
        },
    ])(
        'Should ignore action-catalog import names shadowed by local bindings: $description',
        ({ code }) => {
            expect(extractConnectionIds(parseModule(code), filePath)).toEqual([]);
        },
    );

    test.each([
        {
            description: 'mutable let bindings',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                let CONNECTION_ID = 'mutable-let';
                request({ connectionId: CONNECTION_ID });
            `,
            expected: "declared with 'let'",
        },
        {
            description: 'mutable var bindings',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                var CONNECTION_ID = 'mutable-var';
                request({ connectionId: CONNECTION_ID });
            `,
            expected: "declared with 'var'",
        },
        {
            description: 'unresolved identifiers',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: CONNECTION_ID });
            `,
            expected: "identifier 'CONNECTION_ID' is not a top-level same-file const binding",
        },
        {
            description: 'destructured connection bindings',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const CONNECTIONS = { HTTP: 'destructured-connection-binding' };
                const { HTTP } = CONNECTIONS;
                request({ connectionId: HTTP });
            `,
            expected: "identifier 'HTTP' is not a top-level same-file const binding",
        },
        {
            description: 'imported identifiers',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                import { CONNECTION_ID } from './connections';
                request({ connectionId: CONNECTION_ID });
            `,
            expected: "imported identifier 'CONNECTION_ID' cannot be statically analyzed",
        },
        {
            description: 'imported object members',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                import { CONNECTIONS } from './connections';
                request({ connectionId: CONNECTIONS.HTTP });
            `,
            expected: "imported object 'CONNECTIONS' cannot be statically analyzed",
        },
        {
            description: 'dynamic template literals',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const prefix = 'conn';
                request({ connectionId: \`\${prefix}-dynamic\` });
            `,
            expected: 'template literals with interpolations cannot be statically analyzed',
        },
        {
            description: 'binary expressions',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: 'conn-' + suffix });
            `,
            expected: 'got BinaryExpression',
        },
        {
            description: 'function calls',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: getConnectionId() });
            `,
            expected: 'got CallExpression',
        },
        {
            description: 'env reads',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                request({ connectionId: process.env.CONNECTION_ID });
            `,
            expected: 'nested or non-static member expressions cannot be statically analyzed',
        },
        {
            description: 'computed object properties',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const key = 'HTTP';
                const CONNECTIONS = { [key]: 'computed-object-property' };
                request({ connectionId: CONNECTIONS.HTTP });
            `,
            expected: 'computed object properties can hide connectionId object members',
        },
        {
            description: 'object spreads',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const BASE = { HTTP: 'spread-object' };
                const CONNECTIONS = { ...BASE };
                request({ connectionId: CONNECTIONS.HTTP });
            `,
            expected: 'object spreads can hide connectionId object members',
        },
        {
            description: 'nested member chains',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const CONNECTIONS = { HTTP: { PROD: 'nested-member-chain' } };
                request({ connectionId: CONNECTIONS.HTTP.PROD });
            `,
            expected: 'nested or non-static member expressions cannot be statically analyzed',
        },
        {
            description: 'computed member reads',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const CONNECTIONS = { HTTP: 'computed-member-read' };
                request({ connectionId: CONNECTIONS['HTTP'] });
            `,
            expected: 'computed member expressions cannot be statically analyzed',
        },
        {
            description: 'object members missing a static property',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const CONNECTIONS = { SLACK: 'slack-connection' };
                request({ connectionId: CONNECTIONS.HTTP });
            `,
            expected: "object has no static 'HTTP' property",
        },
        {
            description: 'const object aliases',
            code: `
                import { request } from '@datadog/action-catalog/http/http';
                const BASE = { HTTP: 'aliased-object' };
                const CONNECTIONS = BASE;
                request({ connectionId: CONNECTIONS.HTTP });
            `,
            expected: "object 'CONNECTIONS' must be initialized to an object literal",
        },
    ])(
        'Should fail closed for unsupported connectionId value expressions: $description',
        ({ code, expected }) => {
            expect(() => extractConnectionIds(parseModule(code), filePath)).toThrow(expected);
        },
    );

    describe('module graph analysis', () => {
        test('Should include action calls from imported helper modules in the file-level union', async () => {
            await expect(
                extractFromGraph({
                    '/app/run.backend.ts': `
                        import { getEcho } from './helpers/http';
                        export function run() { return getEcho(); }
                        export function other() {}
                    `,
                    '/app/helpers/http.ts': `
                        ${CATALOG_IMPORT}
                        export function getEcho() {
                            if (Math.random()) {
                                request({ connectionId: 'conditional-helper' });
                            }
                            for (const item of [1]) {
                                request({ connectionId: 'loop-helper' });
                            }
                            return [1].map(() => request({ connectionId: 'callback-helper' }));
                        }
                    `,
                }),
            ).resolves.toEqual(['callback-helper', 'conditional-helper', 'loop-helper']);
        });

        test('Should resolve imported constants and object members', async () => {
            await expect(
                extractFromGraph({
                    '/app/run.backend.ts': `
                        import { runRequest } from './helper';
                        export function run() { return runRequest(); }
                    `,
                    '/app/helper.ts': `
                        ${CATALOG_IMPORT}
                        import { HTTP_ID, CONNECTIONS } from './connections';
                        export function runRequest() {
                            request({ connectionId: HTTP_ID });
                            request({ connectionId: CONNECTIONS.HTTP });
                        }
                    `,
                    '/app/connections.ts': `
                        const INNER = 'imported-constant';
                        export const HTTP_ID = INNER;
                        export const CONNECTIONS = { HTTP: 'imported-object-member' };
                    `,
                }),
            ).resolves.toEqual(['imported-constant', 'imported-object-member']);
        });

        test('Should resolve alias re-exports, local import/export relays, and export star barrels', async () => {
            await expect(
                extractFromGraph({
                    '/app/run.backend.ts': `
                        import { runRequest } from './helper';
                        export function run() { return runRequest(); }
                    `,
                    '/app/helper.ts': `
                        ${CATALOG_IMPORT}
                        import { HTTP_ID, SLACK_ID, DD_ID } from './barrel';
                        export function runRequest() {
                            request({ connectionId: HTTP_ID });
                            request({ connectionId: SLACK_ID });
                            request({ connectionId: DD_ID });
                        }
                    `,
                    '/app/barrel.ts': `
                        export { INNER_HTTP as HTTP_ID } from './real';
                        import { SLACK_ID } from './relay';
                        export { SLACK_ID };
                        export * from './star';
                    `,
                    '/app/real.ts': `export const INNER_HTTP = 'alias-reexport';`,
                    '/app/relay.ts': `export const SLACK_ID = 'local-relay';`,
                    '/app/star.ts': `export const DD_ID = 'star-reexport';`,
                }),
            ).resolves.toEqual(['alias-reexport', 'local-relay', 'star-reexport']);
        });

        test('Should ignore type-only import and re-export declarations during traversal', async () => {
            const files = {
                '/app/run.backend.ts': `
                    import { helper } from './helper';
                    export { helper } from './ignored';
                    export function run() { return helper(); }
                `,
                '/app/helper.ts': `
                    ${CATALOG_IMPORT}
                    export function helper() { request({ connectionId: 'visible' }); }
                `,
                '/app/ignored.ts': `
                    ${CATALOG_IMPORT}
                    request({ connectionId: 'ignored-type-only' });
                `,
            };
            const ctx = createCtx(files);
            const ast = ctx.parse(files['/app/run.backend.ts']) as AstNode & Program;
            (ast.body[0] as ImportDeclaration & { importKind?: string }).importKind = 'type';
            (ast.body[1] as ExportNamedDeclaration & { exportKind?: string }).exportKind = 'type';

            await expect(
                extractConnectionIds(ctx, ast, '/app/run.backend.ts', '/app'),
            ).resolves.toEqual([]);
        });

        test('Should skip side-effect action-catalog imports and non-action package imports', async () => {
            await expect(
                extractFromGraph({
                    '/app/run.backend.ts': `
                        import '@datadog/action-catalog/http/http';
                        import 'lodash';
                        export function run() {}
                    `,
                }),
            ).resolves.toEqual([]);
        });

        test('Should skip modules outside traversal boundaries', async () => {
            await expect(
                extractFromGraph(
                    {
                        '/app/run.backend.ts': `
                            import '../outside';
                            import './dist/generated';
                            import 'virtual:helper';
                            export function run() {}
                        `,
                        '/outside.ts': `
                            ${CATALOG_IMPORT}
                            request({ connectionId: 'outside-root' });
                        `,
                        '/app/dist/generated.ts': `
                            ${CATALOG_IMPORT}
                            request({ connectionId: 'generated-output' });
                        `,
                    },
                    '/app/run.backend.ts',
                    '/app',
                    { virtualIds: new Set(['virtual:helper']) },
                ),
            ).resolves.toEqual([]);
        });

        test('Should fail when a used imported connection value resolves outside buildRoot', async () => {
            await expect(
                extractFromGraph(
                    {
                        '/app/run.backend.ts': `
                            ${CATALOG_IMPORT}
                            import { HTTP_ID } from '../outside';
                            export function run() { request({ connectionId: HTTP_ID }); }
                        `,
                        '/outside.ts': `export const HTTP_ID = 'outside-value';`,
                    },
                    '/app/run.backend.ts',
                    '/app',
                ),
            ).rejects.toThrow(/resolves outside the analyzable module graph/);
        });

        test('Should handle local import cycles without looping forever', async () => {
            await expect(
                extractFromGraph({
                    '/app/run.backend.ts': `
                        import './a';
                        export function run() {}
                    `,
                    '/app/a.ts': `import './b';`,
                    '/app/b.ts': `
                        import './a';
                        ${CATALOG_IMPORT}
                        request({ connectionId: 'cycle-id' });
                    `,
                }),
            ).resolves.toEqual(['cycle-id']);
        });

        test('Should fail clearly for cyclic re-export chains', async () => {
            await expect(
                extractFromGraph({
                    '/app/run.backend.ts': `
                        ${CATALOG_IMPORT}
                        import { HTTP_ID } from './a';
                        export function run() { request({ connectionId: HTTP_ID }); }
                    `,
                    '/app/a.ts': `export { HTTP_ID } from './b';`,
                    '/app/b.ts': `export { HTTP_ID } from './a';`,
                }),
            ).rejects.toThrow(/cyclic const connectionId reference/);
        });

        test.each([
            {
                description: 'dynamic local imports',
                code: `export async function run() { await import('./helper'); }`,
                expected: 'dynamic import of local module',
            },
            {
                description: 'non-literal dynamic imports',
                code: `export async function run(name) { await import(name); }`,
                expected: 'dynamic import sources must be static string literals',
            },
            {
                description: 'local require calls',
                code: `export function run() { require('./helper'); }`,
                expected: 'require of local module',
            },
        ])('Should fail closed for $description', async ({ code, expected }) => {
            await expect(
                extractFromGraph({
                    '/app/run.backend.ts': code,
                    '/app/helper.ts': `export const value = 1;`,
                }),
            ).rejects.toThrow(expected);
        });

        test('Should fail for unresolved local static imports', async () => {
            await expect(
                extractFromGraph({
                    '/app/run.backend.ts': `
                        import './missing';
                        export function run() {}
                    `,
                }),
            ).rejects.toThrow(/could not resolve local module '.\/missing'/);
        });

        test('Should fail for mutable imported bindings and unresolved imported values', async () => {
            await expect(
                extractFromGraph({
                    '/app/run.backend.ts': `
                        ${CATALOG_IMPORT}
                        import { HTTP_ID } from './connections';
                        export function run() { request({ connectionId: HTTP_ID }); }
                    `,
                    '/app/connections.ts': `export let HTTP_ID = 'mutable';`,
                }),
            ).rejects.toThrow(/declared with 'let'/);

            await expect(
                extractFromGraph({
                    '/app/run.backend.ts': `
                        ${CATALOG_IMPORT}
                        import { HTTP_ID } from './connections';
                        export function run() { request({ connectionId: HTTP_ID }); }
                    `,
                    '/app/connections.ts': `export const OTHER = 'other';`,
                }),
            ).rejects.toThrow(/export 'HTTP_ID' not found/);
        });

        test.each([
            {
                description: 'local action aliases',
                helper: `
                    ${CATALOG_IMPORT}
                    const action = request;
                    action({ connectionId: 'alias' });
                `,
                expected: 'action-catalog call aliases cannot be statically analyzed',
            },
            {
                description: 'namespace destructuring aliases',
                helper: `
                    import * as http from '@datadog/action-catalog/http/http';
                    const { request: action } = http;
                    action({ connectionId: 'destructured' });
                `,
                expected: 'action-catalog call aliases cannot be statically analyzed',
            },
            {
                description: 'optional action calls',
                helper: `
                    ${CATALOG_IMPORT}
                    request?.({ connectionId: 'optional' });
                `,
                expected: 'optional chaining cannot be statically analyzed',
            },
            {
                description: 'higher-order invocation',
                helper: `
                    ${CATALOG_IMPORT}
                    runAction(request);
                `,
                expected: 'higher-order action-catalog invocation',
            },
        ])('Should preserve unsupported policy for $description', async ({ helper, expected }) => {
            await expect(
                extractFromGraph({
                    '/app/run.backend.ts': `
                        import './helper';
                        export function run() {}
                    `,
                    '/app/helper.ts': helper,
                }),
            ).rejects.toThrow(expected);
        });

        test('Should fall back to disk read and esbuild transform when Vite ModuleInfo.code is unsupported', async () => {
            const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'connection-id-fallback-'));
            try {
                const entry = path.join(dir, 'run.backend.ts');
                const helper = path.join(dir, 'helper.tsx');
                const files = {
                    [entry]: `
                        import './helper';
                        export function run() {}
                    `,
                    [helper]: `
                        ${CATALOG_IMPORT}
                        const CONNECTIONS = { HTTP: 'fallback-tsx' } as const;
                        request({ connectionId: CONNECTIONS.HTTP });
                    `,
                };
                await fsp.writeFile(entry, files[entry]);
                await fsp.writeFile(helper, files[helper]);

                await expect(
                    extractFromGraph(files, entry, dir, { fallbackLoadIds: new Set([helper]) }),
                ).resolves.toEqual(['fallback-tsx']);
            } finally {
                await fsp.rm(dir, { recursive: true, force: true });
            }
        });
    });
});
