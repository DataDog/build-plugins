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

function run(files: Record<string, string>, entry: string, exports: string[]) {
    const ctx = createCtx(files);
    const ast = ctx.parse(files[entry]);
    return extractConnectionIds(ctx, ast, entry, exports);
}

describe('extractConnectionIds', () => {
    describe('inline literals', () => {
        test('extracts a string-literal connectionId', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        export function foo() {
                            request({ connectionId: 'abc-123', url: '/x' });
                        }
                    `,
                },
                '/app/foo.backend.ts',
                ['foo'],
            );
            expect(result.get('foo')).toEqual(['abc-123']);
        });

        test('extracts a plain template literal connectionId', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        export function foo() {
                            request({ connectionId: \`abc-123\`, url: '/x' });
                        }
                    `,
                },
                '/app/foo.backend.ts',
                ['foo'],
            );
            expect(result.get('foo')).toEqual(['abc-123']);
        });

        test('dedupes repeated IDs and sorts', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        export function foo() {
                            request({ connectionId: 'b', url: '/x' });
                            request({ connectionId: 'a', url: '/y' });
                            request({ connectionId: 'a', url: '/z' });
                        }
                    `,
                },
                '/app/foo.backend.ts',
                ['foo'],
            );
            expect(result.get('foo')).toEqual(['a', 'b']);
        });
    });

    describe('same-file consts', () => {
        test('resolves const to a string literal', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        const CONNECTION_ID = 'xyz-1';
                        export function foo() {
                            request({ connectionId: CONNECTION_ID, url: '/x' });
                        }
                    `,
                },
                '/app/foo.backend.ts',
                ['foo'],
            );
            expect(result.get('foo')).toEqual(['xyz-1']);
        });

        test('resolves const to a plain template literal', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        const CONNECTION_ID = \`xyz-1\`;
                        export function foo() {
                            request({ connectionId: CONNECTION_ID, url: '/x' });
                        }
                    `,
                },
                '/app/foo.backend.ts',
                ['foo'],
            );
            expect(result.get('foo')).toEqual(['xyz-1']);
        });

        test('resolves const-through-const chain', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        const A = 'deep';
                        const B = A;
                        export function foo() { request({ connectionId: B }); }
                    `,
                },
                '/app/foo.backend.ts',
                ['foo'],
            );
            expect(result.get('foo')).toEqual(['deep']);
        });
    });

    describe('imported consts — transitive', () => {
        test('resolves `export const` in a sibling file', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        import { CONN } from './constants';
                        export function foo() { request({ connectionId: CONN }); }
                    `,
                    '/app/constants.ts': `export const CONN = 'imported-1';`,
                },
                '/app/foo.backend.ts',
                ['foo'],
            );
            expect(result.get('foo')).toEqual(['imported-1']);
        });

        test('resolves through a barrel re-export', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        import { CONN } from './barrel';
                        export function foo() { request({ connectionId: CONN }); }
                    `,
                    '/app/barrel.ts': `export { CONN } from './real';`,
                    '/app/real.ts': `export const CONN = 'barrelled';`,
                },
                '/app/foo.backend.ts',
                ['foo'],
            );
            expect(result.get('foo')).toEqual(['barrelled']);
        });

        test('resolves through `export { X as Y } from`', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        import { CONN } from './barrel';
                        export function foo() { request({ connectionId: CONN }); }
                    `,
                    '/app/barrel.ts': `export { INNER as CONN } from './real';`,
                    '/app/real.ts': `export const INNER = 'renamed';`,
                },
                '/app/foo.backend.ts',
                ['foo'],
            );
            expect(result.get('foo')).toEqual(['renamed']);
        });

        test('resolves through `import { X } from; export { X }`', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
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
                ['foo'],
            );
            expect(result.get('foo')).toEqual(['relayed']);
        });

        test('resolves via `export * from`', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
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
                ['foo'],
            );
            expect(result.get('foo')).toEqual(['star']);
        });

        test('throws on cyclic re-export chain', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `
                            import { CONN } from './a';
                            export function foo() { request({ connectionId: CONN }); }
                        `,
                        '/app/a.ts': `export { CONN } from './b';`,
                        '/app/b.ts': `export { CONN } from './a';`,
                    },
                    '/app/foo.backend.ts',
                    ['foo'],
                ),
            ).rejects.toThrow(/cyclic re-export chain/);
        });

        test('throws with clear message when export not found', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `
                            import { CONN } from './constants';
                            export function foo() { request({ connectionId: CONN }); }
                        `,
                        '/app/constants.ts': `export const OTHER = 'x';`,
                    },
                    '/app/foo.backend.ts',
                    ['foo'],
                ),
            ).rejects.toThrow(/export 'CONN' not found/);
        });
    });

    describe('unresolvable forms throw', () => {
        test('dynamic template literal', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `
                            const prefix = 'a';
                            export function foo() {
                                request({ connectionId: \`\${prefix}-b\` });
                            }
                        `,
                    },
                    '/app/foo.backend.ts',
                    ['foo'],
                ),
            ).rejects.toThrow(/must not contain interpolations/);
        });

        test('concatenation', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `
                            export function foo() {
                                request({ connectionId: 'a' + 'b' });
                            }
                        `,
                    },
                    '/app/foo.backend.ts',
                    ['foo'],
                ),
            ).rejects.toThrow(/must be a string literal/);
        });

        test('env var (member expression)', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `
                            export function foo() {
                                request({ connectionId: process.env.CONN });
                            }
                        `,
                    },
                    '/app/foo.backend.ts',
                    ['foo'],
                ),
            ).rejects.toThrow(/must be a string literal/);
        });

        test('function call', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `
                            export function foo() {
                                request({ connectionId: getConn() });
                            }
                        `,
                    },
                    '/app/foo.backend.ts',
                    ['foo'],
                ),
            ).rejects.toThrow(/must be a string literal/);
        });

        test('undefined identifier', async () => {
            await expect(
                run(
                    {
                        '/app/foo.backend.ts': `
                            export function foo() {
                                request({ connectionId: MYSTERY });
                            }
                        `,
                    },
                    '/app/foo.backend.ts',
                    ['foo'],
                ),
            ).rejects.toThrow(/not defined .* and is not imported/);
        });
    });

    describe('multiple exports', () => {
        test('extracts IDs per export independently', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        const A = 'aaa';
                        export function foo() { request({ connectionId: A }); }
                        export function bar() { request({ connectionId: 'bbb' }); }
                    `,
                },
                '/app/foo.backend.ts',
                ['foo', 'bar'],
            );
            expect(result.get('foo')).toEqual(['aaa']);
            expect(result.get('bar')).toEqual(['bbb']);
        });
    });

    describe('no connectionId', () => {
        test('returns empty list when the export never mentions connectionId', async () => {
            const result = await run(
                {
                    '/app/foo.backend.ts': `
                        export function foo() { request({ url: '/x' }); }
                    `,
                },
                '/app/foo.backend.ts',
                ['foo'],
            );
            expect(result.get('foo')).toEqual([]);
        });
    });
});
