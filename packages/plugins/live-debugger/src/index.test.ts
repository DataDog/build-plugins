// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { InjectPosition } from '@dd/core/types';
import { getContextMock, getGetPluginsArg } from '@dd/tests/_jest/helpers/mocks';
import type { UnpluginBuildContext, UnpluginContext } from 'unplugin';

import { PLUGIN_NAME } from './constants';
import { getLiveDebuggerPlugin, getPlugins } from './index';
import { getRuntimeBootstrap } from './runtime-bootstrap';
import type { LiveDebuggerOptionsWithDefaults } from './types';

const makeOptions = (
    overrides: Partial<LiveDebuggerOptionsWithDefaults> = {},
): LiveDebuggerOptionsWithDefaults => ({
    version: '1.0.0',
    include: [/\.[jt]sx?$/],
    exclude: [/\/node_modules\//],
    honorSkipComments: false,
    functionTypes: undefined,
    namedOnly: false,
    ...overrides,
});

const mockContext = getContextMock({ buildRoot: '/' });

const mockBuildContext: UnpluginBuildContext & UnpluginContext = {
    addWatchFile: jest.fn(),
    emitFile: jest.fn(),
    getWatchFiles: jest.fn(() => []),
    parse: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
};

const mockLog = {
    getLogger: jest.fn(),
    time: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
};

beforeEach(() => {
    jest.clearAllMocks();
});

function getTransformHook(plugin: ReturnType<typeof getLiveDebuggerPlugin>) {
    const transform = plugin.transform;

    if (typeof transform !== 'object' || transform === null || !('handler' in transform)) {
        throw new Error('Expected transform to be an ObjectHook with a handler');
    }

    return transform;
}

function getHandler(
    options: LiveDebuggerOptionsWithDefaults,
): (code: string, id: string) => { code: string } {
    const { handler } = getTransformHook(getLiveDebuggerPlugin(options, mockContext));
    return (code: string, id: string) => {
        const result = handler.call(mockBuildContext, code, id);
        if (typeof result === 'object' && result !== null && 'code' in result) {
            return { code: result.code };
        }
        throw new Error('Unexpected handler result');
    };
}

describe('getLiveDebuggerPlugin', () => {
    describe('DD_LD_LIMIT', () => {
        const ORIGINAL_LIMIT = process.env.DD_LD_LIMIT;

        afterEach(() => {
            if (ORIGINAL_LIMIT === undefined) {
                delete process.env.DD_LD_LIMIT;
            } else {
                process.env.DD_LD_LIMIT = ORIGINAL_LIMIT;
            }
            jest.resetModules();
        });

        it('should not count files without functions toward DD_LD_LIMIT', () => {
            process.env.DD_LD_LIMIT = '1';

            jest.isolateModules(() => {
                const { getLiveDebuggerPlugin: freshGetPlugin } =
                    require('./index') as typeof import('./index');
                const plugin = freshGetPlugin(makeOptions(), mockContext);
                const transform = plugin.transform;

                if (
                    typeof transform !== 'object' ||
                    transform === null ||
                    !('handler' in transform)
                ) {
                    throw new Error('Expected transform to be an ObjectHook with a handler');
                }

                const handler = (code: string, id: string) => {
                    const result = transform.handler.call(mockBuildContext, code, id);
                    if (typeof result === 'object' && result !== null && 'code' in result) {
                        return { code: result.code };
                    }
                    throw new Error('Unexpected handler result');
                };

                // A file without functions should not consume DD_LD_LIMIT quota
                handler('const x = 42;', '/src/constants.ts');

                // The first file WITH functions should still be instrumented
                const result = handler('function f() { return 1; }', '/src/utils.ts');
                expect(result.code).toContain('$dd_probes');
            });
        });

        it('should stop instrumenting after DD_LD_LIMIT files with functions', () => {
            process.env.DD_LD_LIMIT = '1';

            jest.isolateModules(() => {
                const { getLiveDebuggerPlugin: freshGetPlugin } =
                    require('./index') as typeof import('./index');
                const plugin = freshGetPlugin(makeOptions(), mockContext);
                const transform = plugin.transform;

                if (
                    typeof transform !== 'object' ||
                    transform === null ||
                    !('handler' in transform)
                ) {
                    throw new Error('Expected transform to be an ObjectHook with a handler');
                }

                const handler = (code: string, id: string) => {
                    const result = transform.handler.call(mockBuildContext, code, id);
                    if (typeof result === 'object' && result !== null && 'code' in result) {
                        return { code: result.code };
                    }
                    throw new Error('Unexpected handler result');
                };

                // First file with functions — within limit
                const result1 = handler('function f() { return 1; }', '/src/a.ts');
                expect(result1.code).toContain('$dd_probes');

                // Second file with functions — exceeds limit
                const code2 = 'function g() { return 2; }';
                const result2 = handler(code2, '/src/b.ts');
                expect(result2.code).toBe(code2);
            });
        });
    });

    describe('child-compilation include-filter fallback', () => {
        it('should skip files not matching any include pattern', () => {
            const handler = getHandler(makeOptions({ include: [/\.tsx?$/] }));
            const code = 'function f() { return 1; }';

            expect(handler(code, '/src/style.css')).toEqual({ code });
        });

        it('should process files matching an include pattern', () => {
            const handler = getHandler(makeOptions({ include: [/\.tsx?$/] }));
            const code = 'function f() { return 1; }';

            expect(handler(code, '/src/utils.ts').code).toContain('$dd_probes');
        });

        it('should skip include filtering when include array is empty', () => {
            const handler = getHandler(makeOptions({ include: [], exclude: [] }));
            const code = 'function f() { return 1; }';

            // With no include patterns, all file types pass through
            expect(handler(code, '/src/anything.xyz').code).toContain('$dd_probes');
        });

        it('should exclude files matching an exclude pattern even if included', () => {
            const handler = getHandler(
                makeOptions({
                    include: [/\.[jt]sx?$/],
                    exclude: [/node_modules/],
                }),
            );
            const code = 'function f() { return 1; }';

            expect(handler(code, '/node_modules/dep/index.ts')).toEqual({ code });
        });

        it('should support string include patterns', () => {
            const handler = getHandler(makeOptions({ include: ['src/'], exclude: [] }));
            const code = 'function f() { return 1; }';

            expect(handler(code, '/project/src/utils.ts').code).toContain('$dd_probes');
            expect(handler(code, '/project/vendor/lib.ts')).toEqual({ code });
        });

        it('should support string exclude patterns', () => {
            const handler = getHandler(
                makeOptions({
                    include: [],
                    exclude: ['vendor/'],
                }),
            );
            const code = 'function f() { return 1; }';

            expect(handler(code, '/project/src/utils.ts').code).toContain('$dd_probes');
            expect(handler(code, '/project/vendor/lib.ts')).toEqual({ code });
        });
    });

    describe('source-map composition', () => {
        const LINES_SHIFTED = 4;

        const buildShiftedInputMap = (sourcePath: string, source: string): string =>
            JSON.stringify({
                version: 3,
                sources: [sourcePath],
                sourcesContent: [source],
                names: [],
                mappings:
                    ';'.repeat(LINES_SHIFTED) +
                    source
                        .split('\n')
                        .map((_, idx) => (idx === 0 ? 'AAAA' : 'AACA'))
                        .join(';'),
            });

        const makeBuildContext = (
            inputSourceMap?: string | null,
        ): UnpluginBuildContext & UnpluginContext => ({
            ...mockBuildContext,
            getNativeBuildContext: () => ({
                framework: 'rspack',
                compiler: {} as never,
                compilation: {} as never,
                inputSourceMap,
            }),
        });

        const callHandler = (
            ctx: UnpluginBuildContext & UnpluginContext,
            code: string,
            id: string,
        ) => {
            const pluginContext = getContextMock({
                buildRoot: '/',
                getLogger: jest.fn(() => mockLog),
            });
            const plugin = getLiveDebuggerPlugin(
                makeOptions({ include: [], exclude: [] }),
                pluginContext,
            );
            const { handler } = getTransformHook(plugin);
            const result = handler.call(ctx, code, id);
            if (typeof result !== 'object' || result === null || !('code' in result)) {
                throw new Error('Unexpected handler result');
            }
            return result;
        };

        it('composes its delta map with the previous loader so positions resolve to original-source lines', async () => {
            const original = 'function getDebuggerServicesStatus() { return 0; }';
            const id = '/src/use-debugger-services.hook.ts';
            const postLoader = `// banner\n// banner\n// banner\n// banner\n${original}`;
            const inputMap = buildShiftedInputMap(id, original);

            const ctx = makeBuildContext(inputMap);
            const result = callHandler(ctx, postLoader, id);

            expect(result.map).toBeDefined();

            const lines = result.code.split('\n');
            const entryLineIndex = lines.findIndex((line) => line.includes('$dd_entry($dd_p'));
            expect(entryLineIndex).toBeGreaterThan(-1);
            const entryColumn = lines[entryLineIndex].indexOf('$dd_entry');

            const { originalPositionFor, TraceMap } = await import('@jridgewell/trace-mapping');
            const traceMap = new TraceMap(
                typeof result.map === 'string' ? result.map : JSON.parse(String(result.map)),
            );
            const original_pos = originalPositionFor(traceMap, {
                line: entryLineIndex + 1,
                column: entryColumn,
            });

            expect(original_pos.line).toBe(1);
            expect(original_pos.source).toBe(id);
        });

        it('returns the magic-string map verbatim when the previous loader did not provide one', async () => {
            const id = '/src/utils.ts';
            const code = 'function f() { return 1; }';

            // No inputSourceMap, no getNativeBuildContext at all.
            const result = callHandler(mockBuildContext, code, id);
            expect(result.map).toBeDefined();

            const map = JSON.parse(String(result.map));
            expect(map.sources).toContain(id);
        });

        it('returns no map when the file has no instrumentable functions', () => {
            const result = callHandler(mockBuildContext, 'const x = 42;', '/src/utils.ts');
            expect(result.map).toBeUndefined();
        });

        it('falls back to the un-composed map and logs an error when composition throws', () => {
            const id = '/src/utils.ts';
            const code = 'function f() { return 1; }';

            const ctx = makeBuildContext('not a valid sourcemap, this should throw');
            const result = callHandler(ctx, code, id);

            expect(result.map).toBeDefined();
            expect(() => JSON.parse(String(result.map))).not.toThrow();

            expect(mockLog.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed to compose source map'),
                expect.objectContaining({ forward: true }),
            );
        });
    });

    describe('error handling', () => {
        it('should return original code when transformCode throws', () => {
            jest.isolateModules(() => {
                jest.doMock('./transform', () => ({
                    transformCode: () => {
                        throw new Error('boom');
                    },
                }));
                const { getLiveDebuggerPlugin: freshGetPlugin } =
                    require('./index') as typeof import('./index');

                const ctx = getContextMock({
                    buildRoot: '/',
                    getLogger: jest.fn(() => mockLog),
                });
                const plugin = freshGetPlugin(makeOptions({ include: [], exclude: [] }), ctx);
                const transform = plugin.transform;

                if (
                    typeof transform !== 'object' ||
                    transform === null ||
                    !('handler' in transform)
                ) {
                    throw new Error('Expected transform to be an ObjectHook with a handler');
                }

                const code = 'function f() { return 1; }';
                const result = transform.handler.call(mockBuildContext, code, '/src/a.ts');
                if (typeof result !== 'object' || result === null || !('code' in result)) {
                    throw new Error('Unexpected handler result');
                }
                expect(result.code).toBe(code);
                expect(mockLog.error).toHaveBeenCalledWith(
                    expect.stringContaining('Instrumentation Error'),
                    expect.objectContaining({ forward: true }),
                );
            });
        });
    });

    describe('buildEnd', () => {
        it('should log stats after instrumenting files', () => {
            const ctx = getContextMock({
                buildRoot: '/',
                getLogger: jest.fn(() => mockLog),
            });
            const plugin = getLiveDebuggerPlugin(makeOptions({ include: [], exclude: [] }), ctx);
            const { handler } = getTransformHook(plugin);

            handler.call(mockBuildContext, 'function f() { return 1; }', '/src/a.ts');

            plugin.buildEnd!.call(mockBuildContext);

            expect(mockLog.info).toHaveBeenCalledWith(
                expect.stringContaining('Live Debugger:'),
                expect.objectContaining({
                    forward: true,
                    context: expect.objectContaining({
                        instrumentedCount: expect.any(Number),
                        totalFunctions: expect.any(Number),
                        transformedFileCount: expect.any(Number),
                    }),
                }),
            );
        });

        it('should not log when no functions were found', () => {
            const ctx = getContextMock({
                buildRoot: '/',
                getLogger: jest.fn(() => mockLog),
            });
            const plugin = getLiveDebuggerPlugin(makeOptions({ include: [], exclude: [] }), ctx);
            const { handler } = getTransformHook(plugin);

            handler.call(mockBuildContext, 'const x = 42;', '/src/a.ts');

            plugin.buildEnd!.call(mockBuildContext);

            expect(mockLog.info).not.toHaveBeenCalled();
        });
    });
});

describe('getPlugins', () => {
    it('should inject runtime stubs and return a plugin when an empty config is provided', () => {
        const arg = getGetPluginsArg({ liveDebugger: {} });

        const plugins = getPlugins(arg);

        expect(plugins).toHaveLength(1);
        expect(plugins[0].name).toBe(PLUGIN_NAME);
        expect(arg.context.inject).toHaveBeenCalledWith({
            type: 'code',
            position: InjectPosition.BEFORE,
            allChunks: true,
            value: getRuntimeBootstrap(),
        });
    });

    it('should inject build metadata when metadata.version is provided', () => {
        const arg = getGetPluginsArg({
            liveDebugger: {},
            metadata: { version: '1.0.0' },
        });

        const plugins = getPlugins(arg);

        expect(plugins).toHaveLength(1);
        expect(plugins[0].name).toBe(PLUGIN_NAME);
        expect(arg.context.inject).toHaveBeenCalledWith({
            type: 'code',
            position: InjectPosition.BEFORE,
            allChunks: true,
            value: getRuntimeBootstrap('1.0.0'),
        });
    });

    it('should not inject build metadata when only metadata.name is provided', () => {
        const arg = getGetPluginsArg({
            liveDebugger: {},
            metadata: { name: 'my-build' },
        });

        const plugins = getPlugins(arg);

        expect(plugins).toHaveLength(1);
        expect(arg.context.inject).toHaveBeenCalledWith({
            type: 'code',
            position: InjectPosition.BEFORE,
            allChunks: true,
            value: getRuntimeBootstrap(),
        });
    });
});
