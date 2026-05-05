// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { extractConnectionIds } from '@dd/apps-plugin/backend/extract-connection-ids';
import { parse } from 'acorn';
import type { AstNode, PluginContext } from 'rollup';

/**
 * Build a mock PluginContext that can parse code and resolve/load files from
 * an in-memory file map. Enough surface to exercise the extractor without
 * starting a real Rollup build.
 */
function createCtx(files: Record<string, string>): PluginContext {
    const ctx = {
        parse: (code: string): AstNode =>
            parse(code, { ecmaVersion: 2022, sourceType: 'module', locations: true }) as AstNode,
        resolve: async (source: string, importer?: string) => {
            const resolvedId = resolveSimple(source, importer, files);
            if (!resolvedId) {
                return null;
            }
            return { id: resolvedId, external: false };
        },
        load: async ({ id }: { id: string }) => {
            if (!(id in files)) {
                throw new Error(`mock load: no file ${id}`);
            }
            return { id, code: files[id], ast: null };
        },
        debug: (_msg: string) => {
            /* no-op for tests */
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

    const base = importer.replace(/\/[^/]+$/, '');
    const joined = source.startsWith('.') ? `${base}/${source.replace(/^\.\//, '')}` : source;
    // Normalise `../` segments.
    const parts = joined.split('/');
    const out: string[] = [];
    for (const p of parts) {
        if (p === '..') {
            out.pop();
        } else if (p !== '.' && p !== '') {
            out.push(p);
        }
    }
    const candidate = `/${out.join('/')}`;
    if (candidate in files) {
        return candidate;
    }
    for (const ext of ['.ts', '.js', '/index.ts', '/index.js']) {
        if (`${candidate}${ext}` in files) {
            return `${candidate}${ext}`;
        }
    }
    return null;
}

/** Standard action-catalog import prepended to fixtures so `request(…)` is recognised. */
const CATALOG_IMPORT = `import { request } from '@datadog/action-catalog/http/http';\n`;

function run(files: Record<string, string>, entry: string) {
    const ctx = createCtx(files);
    const ast = ctx.parse(files[entry]);
    return extractConnectionIds(ctx, ast, entry);
}

describe('extractConnectionIds', () => {
    describe('inline literals', () => {
        test('extracts a string-literal connectionId', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        export function foo() {
                            request({ connectionId: 'abc-123', url: '/x' });
                        }
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['abc-123']);
        });

        test('extracts a plain template literal connectionId', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        export function foo() {
                            request({ connectionId: \`abc-123\`, url: '/x' });
                        }
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['abc-123']);
        });

        test('dedupes repeated IDs and sorts', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        export function foo() {
                            request({ connectionId: 'b', url: '/x' });
                            request({ connectionId: 'a', url: '/y' });
                            request({ connectionId: 'a', url: '/z' });
                        }
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['a', 'b']);
        });
    });

    describe('same-file consts', () => {
        test('resolves const to a string literal', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        const CONNECTION_ID = 'xyz-1';
                        export function foo() {
                            request({ connectionId: CONNECTION_ID, url: '/x' });
                        }
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['xyz-1']);
        });

        test('resolves const to a plain template literal', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        const CONNECTION_ID = \`xyz-1\`;
                        export function foo() {
                            request({ connectionId: CONNECTION_ID, url: '/x' });
                        }
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['xyz-1']);
        });

        test('resolves const-through-const chain', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        const A = 'deep';
                        const B = A;
                        export function foo() { request({ connectionId: B }); }
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['deep']);
        });
    });

    describe('specifier exports', () => {
        test('resolves `function foo(){}; export { foo }`', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        function foo() { request({ connectionId: 'abc-123' }); }
                        export { foo };
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['abc-123']);
        });

        test('resolves `const foo = () => {}; export { foo }`', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        const foo = () => { request({ connectionId: 'abc-123' }); };
                        export { foo };
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['abc-123']);
        });

        test('resolves `export { foo as bar }` (alias)', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        function foo() { request({ connectionId: 'abc-123' }); }
                        export { foo as bar };
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('bar')).toEqual(['abc-123']);
        });

        test('traverses `import { handler } from "./x"; export { handler }`', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        import { handler } from './handlers';
                        export { handler };
                    `,
                    '/app/handlers.ts': `${CATALOG_IMPORT}
                        export function handler() { request({ connectionId: 'abc-123' }); }
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('handler')).toEqual(['abc-123']);
        });

        test('traverses `export { X } from "./x"` re-exports', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        export { handler } from './handlers';
                    `,
                    '/app/handlers.ts': `${CATALOG_IMPORT}
                        export function handler() { request({ connectionId: 'abc-123' }); }
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('handler')).toEqual(['abc-123']);
        });
    });

    describe('imported consts — transitive', () => {
        test('resolves `export const` in a sibling file', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        import { CONN } from './constants';
                        export function foo() { request({ connectionId: CONN }); }
                    `,
                    '/app/constants.ts': `export const CONN = 'imported-1';`,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['imported-1']);
        });

        test('resolves through a barrel re-export', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        import { CONN } from './barrel';
                        export function foo() { request({ connectionId: CONN }); }
                    `,
                    '/app/barrel.ts': `export { CONN } from './real';`,
                    '/app/real.ts': `export const CONN = 'barrelled';`,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['barrelled']);
        });

        test('resolves through `export { X as Y } from`', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        import { CONN } from './barrel';
                        export function foo() { request({ connectionId: CONN }); }
                    `,
                    '/app/barrel.ts': `export { INNER as CONN } from './real';`,
                    '/app/real.ts': `export const INNER = 'renamed';`,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['renamed']);
        });

        test('resolves through `import { X } from; export { X }`', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        import { CONN } from './mid';
                        export function foo() { request({ connectionId: CONN }); }
                    `,
                    '/app/mid.ts': `
                        import { CONN } from './real';
                        export { CONN };
                    `,
                    '/app/real.ts': `export const CONN = 'relayed';`,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['relayed']);
        });

        test('resolves via `export * from`', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        import { CONN } from './barrel';
                        export function foo() { request({ connectionId: CONN }); }
                    `,
                    '/app/barrel.ts': `
                        export * from './other';
                        export * from './real';
                    `,
                    '/app/other.ts': `export const UNUSED = 'u';`,
                    '/app/real.ts': `export const CONN = 'star';`,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['star']);
        });

        test('throws on cyclic re-export chain', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `${CATALOG_IMPORT}
                            import { CONN } from './a';
                            export function foo() { request({ connectionId: CONN }); }
                        `,
                        '/app/a.ts': `export { CONN } from './b';`,
                        '/app/b.ts': `export { CONN } from './a';`,
                    },
                    '/app/foo.backend.ts',
                ),
            ).rejects.toThrow(/cyclic re-export or import chain/);
        });

        test('throws with clear message when export not found', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `${CATALOG_IMPORT}
                            import { CONN } from './constants';
                            export function foo() { request({ connectionId: CONN }); }
                        `,
                        '/app/constants.ts': `export const OTHER = 'x';`,
                    },
                    '/app/foo.backend.ts',
                ),
            ).rejects.toThrow(/export 'CONN' not found/);
        });
    });

    describe('callee scoping', () => {
        test('ignores `connectionId` passed to non-action-catalog callees', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        import { logger } from './logger';
                        export function foo() {
                            logger.info({ connectionId: process.env.WHATEVER });
                            request({ connectionId: 'abc-123' });
                        }
                    `,
                    '/app/logger.ts': `export const logger = { info: () => {} };`,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['abc-123']);
        });

        test('recognises namespace-imported action-catalog calls', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        import * as http from '@datadog/action-catalog/http/http';
                        export function foo() {
                            http.request({ connectionId: 'abc-123' });
                        }
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['abc-123']);
        });

        test('recognises default-imported action-catalog calls', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        import request from '@datadog/action-catalog/http/http';
                        export function foo() {
                            request({ connectionId: 'abc-123' });
                        }
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['abc-123']);
        });

        test('ignores a locally-defined function with the same name as a catalog call', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        function request(_opts) {}
                        export function foo() {
                            request({ connectionId: process.env.WHATEVER });
                        }
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual([]);
        });
    });

    describe('unresolvable forms throw', () => {
        test('dynamic template literal', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `${CATALOG_IMPORT}
                            const prefix = 'a';
                            export function foo() {
                                request({ connectionId: \`\${prefix}-b\` });
                            }
                        `,
                    },
                    '/app/foo.backend.ts',
                ),
            ).rejects.toThrow(/must not contain interpolations/);
        });

        test('concatenation', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `${CATALOG_IMPORT}
                            export function foo() {
                                request({ connectionId: 'a' + 'b' });
                            }
                        `,
                    },
                    '/app/foo.backend.ts',
                ),
            ).rejects.toThrow(/must be a static string/);
        });

        test('env var (member expression)', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `${CATALOG_IMPORT}
                            export function foo() {
                                request({ connectionId: process.env.CONN });
                            }
                        `,
                    },
                    '/app/foo.backend.ts',
                ),
            ).rejects.toThrow(/member expressions must read from a const object/);
        });

        test('function call', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `${CATALOG_IMPORT}
                            export function foo() {
                                request({ connectionId: getConn() });
                            }
                        `,
                    },
                    '/app/foo.backend.ts',
                ),
            ).rejects.toThrow(/must be a static string/);
        });

        test('undefined identifier', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `${CATALOG_IMPORT}
                            export function foo() {
                                request({ connectionId: MYSTERY });
                            }
                        `,
                    },
                    '/app/foo.backend.ts',
                ),
            ).rejects.toThrow(/not defined .* and is not imported/);
        });

        test('let binding (reassignable)', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `${CATALOG_IMPORT}
                            let CONN = 'initial';
                            export function foo() {
                                request({ connectionId: CONN });
                            }
                        `,
                    },
                    '/app/foo.backend.ts',
                ),
            ).rejects.toThrow(/must resolve to a 'const' binding.*'let'/);
        });

        test('var binding (reassignable)', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `${CATALOG_IMPORT}
                            var CONN = 'initial';
                            export function foo() {
                                request({ connectionId: CONN });
                            }
                        `,
                    },
                    '/app/foo.backend.ts',
                ),
            ).rejects.toThrow(/must resolve to a 'const' binding.*'var'/);
        });

        test('imported let binding (from another file)', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `${CATALOG_IMPORT}
                            import { CONN } from './mutable';
                            export function foo() { request({ connectionId: CONN }); }
                        `,
                        '/app/mutable.ts': `export let CONN = 'initial';`,
                    },
                    '/app/foo.backend.ts',
                ),
            ).rejects.toThrow(/must resolve to a 'const' binding.*'let'/);
        });
    });

    describe('multiple exports', () => {
        test('applies the file-level module graph allowlist to every export', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        const A = 'aaa';
                        export function foo() { request({ connectionId: A }); }
                        export function bar() { request({ connectionId: 'bbb' }); }
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['aaa', 'bbb']);
            expect(result.get('bar')).toEqual(['aaa', 'bbb']);
        });
    });

    describe('reachable module graph', () => {
        test('includes action calls inside same-file helpers', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        function helper() { request({ connectionId: 'helper-id' }); }
                        export function foo() { return helper(); }
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['helper-id']);
        });

        test('includes action calls inside imported helpers', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        import { getHosts } from './helpers/hosts';
                        export function foo() { return getHosts(); }
                    `,
                    '/app/helpers/hosts.ts': `${CATALOG_IMPORT}
                        export function getHosts() {
                            return request({ connectionId: 'helper-id' });
                        }
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['helper-id']);
        });

        test('includes action calls from static re-export sources', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        export { getHosts } from './helpers';
                        export function foo() {}
                    `,
                    '/app/helpers.ts': `
                        export { getHosts } from './real-helper';
                    `,
                    '/app/real-helper.ts': `${CATALOG_IMPORT}
                        export function getHosts() {
                            return request({ connectionId: 'reexport-helper-id' });
                        }
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['reexport-helper-id']);
            expect(result.get('getHosts')).toEqual(['reexport-helper-id']);
        });

        test('resolves imported CONNECTIONS object member access', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        import { getHosts } from './helpers/hosts';
                        export function foo() { return getHosts(); }
                    `,
                    '/app/helpers/hosts.ts': `${CATALOG_IMPORT}
                        import { CONNECTIONS } from '../connections';
                        export function getHosts() {
                            return request({ connectionId: CONNECTIONS.DD });
                        }
                    `,
                    '/app/connections.ts': `
                        export const CONNECTIONS = {
                            DD: 'dd-connection',
                            OTHER: 'other',
                        };
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['dd-connection']);
        });

        test('handles cycles in the reachable module graph', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        import { helper } from './a';
                        export function foo() { return helper(); }
                    `,
                    '/app/a.ts': `
                        import './b';
                        export function helper() {}
                    `,
                    '/app/b.ts': `
                        import './a';
                        ${CATALOG_IMPORT}
                        request({ connectionId: 'cycle-id' });
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual(['cycle-id']);
        });

        test('rejects dynamic local imports', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `
                            export async function foo() {
                                await import('./helpers');
                            }
                        `,
                        '/app/helpers.ts': `${CATALOG_IMPORT}
                            request({ connectionId: 'hidden' });
                        `,
                    },
                    '/app/foo.backend.ts',
                ),
            ).rejects.toThrow(/dynamic import of local module/);
        });

        test('rejects local require calls', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `
                            export function foo() {
                                require('./helpers');
                            }
                        `,
                        '/app/helpers.ts': `${CATALOG_IMPORT}
                            request({ connectionId: 'hidden' });
                        `,
                    },
                    '/app/foo.backend.ts',
                ),
            ).rejects.toThrow(/require of local module/);
        });
    });

    describe('no connectionId', () => {
        test('returns empty list when the export never mentions connectionId', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `${CATALOG_IMPORT}
                        export function foo() { request({ url: '/x' }); }
                    `,
                },
                '/app/foo.backend.ts',
            );
            expect(result.get('foo')).toEqual([]);
        });
    });
});
