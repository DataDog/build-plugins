// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogRollupPlugin } from '@datadog/rollup-plugin';
import { datadogRspackPlugin } from '@datadog/rspack-plugin';
import { datadogVitePlugin } from '@datadog/vite-plugin';
import { outputFileSync, readFileSync, rm } from '@dd/core/helpers/fs';
import { getUniqueId } from '@dd/core/helpers/strings';
import { prepareWorkingDir } from '@dd/tests/_jest/helpers/env';
import { defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { buildWithRollup, buildWithRspack, buildWithVite, configVite } from '@dd/tools/bundlers';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import path from 'path';
import type { Plugin, RollupOptions } from 'rollup';
import { createServer } from 'vite';
import type { UserConfig } from 'vite';

// Tiny rspack/webpack loader that publishes an identity source map for the
// modules it touches. It is required because unplugin's rspack/webpack
// transform loader silently drops `res.map` when the *input* source map is
// null.
const IDENTITY_SHIM_LOADER_SOURCE = `
module.exports = function (source) {
    this.cacheable && this.cacheable();
    const callback = this.async();
    const lines = source.split('\\n');
    const mappings = lines
        .map((_, idx) => (idx === 0 ? 'AAAA' : 'AACA'))
        .join(';');
    callback(null, source, {
        version: 3,
        sources: [this.resourcePath],
        sourcesContent: [source],
        names: [],
        mappings: mappings,
    });
};
`;

const BANNER_LINES = 4;
const BANNER_SHIFT_SHIM_LOADER_SOURCE = `
const BANNER = ${JSON.stringify('// banner\n'.repeat(BANNER_LINES))};
module.exports = function (source) {
    this.cacheable && this.cacheable();
    const callback = this.async();
    const lines = source.split('\\n');
    // Identity-by-line mappings for the original source, prefixed with
    // ${BANNER_LINES} empty entries for the banner lines (which have no
    // original source position).
    const sourceMappings = lines
        .map((_, idx) => (idx === 0 ? 'AAAA' : 'AACA'))
        .join(';');
    const mappings = ';'.repeat(${BANNER_LINES}) + sourceMappings;
    callback(null, BANNER + source, {
        version: 3,
        sources: [this.resourcePath],
        sourcesContent: [source],
        names: [],
        mappings: mappings,
    });
};
`;

describe('Live Debugger sourcemaps', () => {
    const seed = `${Math.abs(jest.getSeed())}.${getUniqueId()}`;
    let workingDir: string;

    beforeAll(async () => {
        workingDir = await prepareWorkingDir(seed);
    });

    afterAll(async () => {
        if (!process.env.NO_CLEANUP) {
            await rm(workingDir);
        }
    });

    const ENTRY_SOURCE = [
        'function helper() {',
        "    return 'helper';",
        '}',
        '',
        'function getDebuggerServicesStatus(isLoadingCritical) {',
        "    return isLoadingCritical ? 'loading' : 'completed';",
        '}',
        '',
        'getDebuggerServicesStatus(false);',
    ].join('\n');

    /**
     * Build the entry through rspack with the live-debugger plugin enabled and
     * the given upstream loader, then return the bundle, its source map, and
     * a few key positions used by every assertion below. Centralizing this
     * keeps the actual test bodies focused on the source-map invariants they
     * are checking and avoids re-stating the bundler config in every case.
     */
    const buildAndLocate = async (upstreamShimLoaderSource: string, outputSubdir: string) => {
        const entry = path.resolve(workingDir, 'live-debugger-entry.js');
        const outDir = path.resolve(workingDir, outputSubdir);
        const shimLoader = path.resolve(workingDir, `${outputSubdir}-loader.cjs`);

        outputFileSync(shimLoader, upstreamShimLoaderSource);
        outputFileSync(entry, ENTRY_SOURCE);

        const { errors } = await buildWithRspack({
            context: workingDir,
            mode: 'none',
            devtool: 'source-map',
            entry: { main: entry },
            output: {
                path: outDir,
                filename: '[name].js',
            },
            resolve: {
                extensions: ['.js'],
            },
            module: {
                // Stand-in for the source-map-producing loader (swc/babel/ts/...)
                // that would normally precede the Datadog plugin in a real build.
                rules: [{ test: /\.js$/, use: [{ loader: shimLoader }] }],
            },
            plugins: [
                datadogRspackPlugin({
                    ...defaultPluginOptions,
                    liveDebugger: {
                        enable: true,
                    },
                    metadata: {
                        version: 'test-version',
                    },
                }),
            ],
        });

        expect(errors).toEqual([]);

        const bundle = readFileSync(path.resolve(outDir, 'main.js'));
        const sourceMap = JSON.parse(readFileSync(path.resolve(outDir, 'main.js.map')));
        const lines = bundle.split('\n');

        const probeDeclLine = lines.findIndex((line) =>
            line.includes('live-debugger-entry.js;getDebuggerServicesStatus'),
        );
        const entryCallLine = lines.findIndex(
            (line, idx) => idx > probeDeclLine && line.includes('$dd_entry($dd_p'),
        );
        const functionDeclLine = lines.findIndex((line) =>
            line.includes('function getDebuggerServicesStatus(isLoadingCritical)'),
        );

        expect(probeDeclLine).toBeGreaterThan(-1);
        expect(entryCallLine).toBeGreaterThan(-1);
        expect(functionDeclLine).toBeGreaterThan(-1);

        return {
            traceMap: new TraceMap(sourceMap),
            probeDeclLine,
            probeDeclColumn: lines[probeDeclLine].indexOf(
                'live-debugger-entry.js;getDebuggerServicesStatus',
            ),
            entryCallLine,
            entryCallColumn: lines[entryCallLine].indexOf('$dd_entry'),
            functionDeclLine,
            functionDeclColumn: lines[functionDeclLine].indexOf('function '),
        };
    };

    it('produces line- and column-accurate sourcemaps after rspack', async () => {
        const located = await buildAndLocate(
            IDENTITY_SHIM_LOADER_SOURCE,
            'dist-live-debugger-rspack-identity',
        );

        expect(
            originalPositionFor(located.traceMap, {
                line: located.probeDeclLine + 1,
                column: located.probeDeclColumn,
            }),
        ).toEqual(expect.objectContaining({ line: 5 }));

        expect(
            originalPositionFor(located.traceMap, {
                line: located.entryCallLine + 1,
                column: located.entryCallColumn,
            }),
        ).toEqual(expect.objectContaining({ line: 5 }));

        expect(
            originalPositionFor(located.traceMap, {
                line: located.functionDeclLine + 1,
                column: located.functionDeclColumn,
            }),
        ).toEqual(expect.objectContaining({ line: 5, column: 0 }));
    });

    it('composes its source map with the previous loader so injected positions are reported in original-source coordinates', async () => {
        const located = await buildAndLocate(
            BANNER_SHIFT_SHIM_LOADER_SOURCE,
            'dist-live-debugger-rspack-shifted',
        );

        const probeDeclResolved = originalPositionFor(located.traceMap, {
            line: located.probeDeclLine + 1,
            column: located.probeDeclColumn,
        });
        const entryCallResolved = originalPositionFor(located.traceMap, {
            line: located.entryCallLine + 1,
            column: located.entryCallColumn,
        });
        const functionDeclResolved = originalPositionFor(located.traceMap, {
            line: located.functionDeclLine + 1,
            column: located.functionDeclColumn,
        });

        // Every position we care about must point at line 5 of the original
        // source, NOT line 5 + BANNER_LINES of the post-loader buffer.
        expect(probeDeclResolved).toEqual(expect.objectContaining({ line: 5 }));
        expect(entryCallResolved).toEqual(expect.objectContaining({ line: 5 }));
        expect(functionDeclResolved).toEqual(expect.objectContaining({ line: 5, column: 0 }));

        // Defensive: explicitly assert that none of the resolved positions
        // are pointing at the banner area. Without composition the injected
        // probe positions would land on lines 5..(5 + BANNER_LINES) of what
        // the bundler thinks is the original source.
        for (const resolved of [probeDeclResolved, entryCallResolved, functionDeclResolved]) {
            expect(resolved.line).not.toBeGreaterThan(5);
        }
    });

    // Rollup drops a module's mappings when a transform returns code without a
    // map, so modules the plugin leaves unchanged must not report a missing map.
    const unchangedModuleCases = [
        {
            description: 'a module without functions',
            name: 'no-functions',
            source: ['export const LABELS = [', "    ['live', 'debugger'].join('-'),", '];'].join(
                '\n',
            ),
            marker: "['live', 'debugger']",
            expectedLine: 2,
        },
        {
            description: 'a module with only generator functions',
            name: 'generators-only',
            source: ['export function* labels() {', "    yield 'live-debugger';", '}'].join('\n'),
            marker: "yield 'live-debugger'",
            expectedLine: 2,
        },
    ];

    test.each(unchangedModuleCases)(
        'should keep the Rollup source map of $description',
        async ({ name, source, marker, expectedLine }) => {
            const caseDir = path.resolve(workingDir, `rollup-unchanged-${name}`);
            const entry = path.resolve(caseDir, 'entry.js');
            const unchangedModule = path.resolve(caseDir, 'unchanged.js');
            const outDir = path.resolve(caseDir, 'dist');
            const entrySource = [
                "import * as unchanged from './unchanged.js';",
                'export function describeUnchanged() {',
                "    return Object.keys(unchanged).join(',');",
                '}',
            ].join('\n');
            outputFileSync(unchangedModule, source);
            outputFileSync(entry, entrySource);

            const warningCodes: Array<string | undefined> = [];
            const rollupConfig: RollupOptions = {
                input: { main: entry },
                onwarn: (warning) => {
                    warningCodes.push(warning.code);
                },
                output: {
                    dir: outDir,
                    entryFileNames: '[name].js',
                    format: 'esm',
                    sourcemap: true,
                },
                plugins: [
                    datadogRollupPlugin({
                        ...defaultPluginOptions,
                        liveDebugger: {
                            enable: true,
                        },
                    }),
                ],
            };
            const { errors } = await buildWithRollup(rollupConfig);

            expect(errors).toEqual([]);
            expect(warningCodes).not.toContain('SOURCEMAP_BROKEN');

            const bundlePath = path.resolve(outDir, 'main.js');
            const sourceMapPath = path.resolve(outDir, 'main.js.map');
            const bundle = readFileSync(bundlePath);
            const sourceMapContent = readFileSync(sourceMapPath);
            const sourceMap = JSON.parse(sourceMapContent);
            const lines = bundle.split('\n');
            const markerLine = lines.findIndex((line) => line.includes(marker));
            expect(markerLine).toBeGreaterThan(-1);

            const traceMap = new TraceMap(sourceMap);
            const markerColumn = lines[markerLine].indexOf(marker);
            const resolved = originalPositionFor(traceMap, {
                line: markerLine + 1,
                column: markerColumn,
            });
            expect(resolved.source).toMatch(/unchanged\.js$/);
            expect(resolved.line).toBe(expectedLine);
        },
    );

    // An injected `this` at the top level of a module made Rollup warn THIS_IS_UNDEFINED, and
    // SOURCEMAP_ERROR where it couldn't map the warning back to the source. Vite showed the
    // second for every instrumented arrow function at the top level of a module.
    describe('this at the top level of a module', () => {
        const TOP_LEVEL_ARROWS_SOURCE = [
            'export const actions = {',
            '    load: async ({ commit }, id) => {',
            "        commit('set', id);",
            '        return id;',
            '    },',
            '};',
            'export const double = (value) => value * 2;',
        ].join('\n');
        const LIVE_DEBUGGER_OPTIONS = {
            ...defaultPluginOptions,
            liveDebugger: {
                enable: true,
                exceptionReplay: true,
            },
        };

        const writeEntry = (name: string) => {
            const caseDir = path.resolve(workingDir, name);
            const entry = path.resolve(caseDir, 'entry.js');
            const outDir = path.resolve(caseDir, 'dist');
            outputFileSync(entry, TOP_LEVEL_ARROWS_SOURCE);
            return { caseDir, entry, outDir };
        };

        const VOID_ENTRY_CALL = '$dd_entry($dd_p0, void 0';
        const WINDOW_ENTRY_CALL = '$dd_entry($dd_p0, window';
        const setContextPlugin: Plugin = {
            name: 'set-context',
            options: (inputOptions) => ({ ...inputOptions, context: 'window' }),
        };

        const buildRollup = async (
            entry: string,
            outDir: string,
            overrides: RollupOptions,
            laterPlugins: Plugin[],
        ) => {
            const warningCodes: Array<string | undefined> = [];
            const rollupConfig: RollupOptions = {
                input: { main: entry },
                onwarn: (warning) => {
                    warningCodes.push(warning.code);
                },
                output: {
                    dir: outDir,
                    entryFileNames: '[name].js',
                    format: 'esm',
                    sourcemap: true,
                },
                ...overrides,
                plugins: [datadogRollupPlugin(LIVE_DEBUGGER_OPTIONS), ...laterPlugins],
            };
            const { errors } = await buildWithRollup(rollupConfig);
            const bundlePath = path.resolve(outDir, 'main.js');
            const bundle = readFileSync(bundlePath);
            return { errors, bundle, warningCodes };
        };

        const rollupCases: Array<{
            description: string;
            name: string;
            overrides: RollupOptions;
            laterPlugins: Plugin[];
            expectedEntryCall: string;
        }> = [
            {
                description: 'pass void 0 without warnings by default',
                name: 'rollup-top-level-this',
                overrides: {},
                laterPlugins: [],
                expectedEntryCall: VOID_ENTRY_CALL,
            },
            {
                description: 'keep the this the context option gives',
                name: 'rollup-top-level-this-context',
                overrides: { context: 'window' },
                laterPlugins: [],
                expectedEntryCall: WINDOW_ENTRY_CALL,
            },
            {
                description: "keep the this a later plugin's options hook gives",
                name: 'rollup-top-level-this-later-plugin',
                overrides: {},
                laterPlugins: [setContextPlugin],
                expectedEntryCall: WINDOW_ENTRY_CALL,
            },
        ];

        test.each(rollupCases)(
            'should $description with Rollup',
            async ({ name, overrides, laterPlugins, expectedEntryCall }) => {
                const { entry, outDir } = writeEntry(name);
                const { errors, bundle, warningCodes } = await buildRollup(
                    entry,
                    outDir,
                    overrides,
                    laterPlugins,
                );

                expect(errors).toEqual([]);
                expect(bundle).toContain(expectedEntryCall);
                expect(warningCodes).toEqual([]);
            },
        );

        it('should keep the this the moduleContext option gives only in its module with Rollup', async () => {
            const { caseDir, entry, outDir } = writeEntry('rollup-top-level-this-module-context');
            const otherModule = path.resolve(caseDir, 'other.js');
            const entrySource = [
                "import { triple } from './other.js';",
                'export const sextuple = (value) => triple(value) * 2;',
            ].join('\n');
            outputFileSync(otherModule, 'export const triple = (value) => value * 3;');
            outputFileSync(entry, entrySource);

            const { errors, bundle, warningCodes } = await buildRollup(
                entry,
                outDir,
                { moduleContext: { [entry]: 'window' } },
                [],
            );

            expect(errors).toEqual([]);
            expect(bundle).toContain(WINDOW_ENTRY_CALL);
            expect(bundle).toContain(VOID_ENTRY_CALL);
            expect(warningCodes).toEqual([]);
        });

        const viteCases = [
            {
                description: 'pass void 0 without warnings by default',
                name: 'vite-top-level-this',
                context: undefined,
                expectedEntryCall: VOID_ENTRY_CALL,
            },
            {
                description: 'keep the this the context option gives',
                name: 'vite-top-level-this-context',
                context: 'window',
                expectedEntryCall: WINDOW_ENTRY_CALL,
            },
        ];

        test.each(viteCases)(
            'should $description with Vite',
            async ({ name, context, expectedEntryCall }) => {
                const { caseDir, entry, outDir } = writeEntry(name);
                const warningCodes: Array<string | undefined> = [];
                const viteConfig = configVite({
                    workingDir: caseDir,
                    outDir,
                    entry: { main: entry },
                    plugins: [datadogVitePlugin(LIVE_DEBUGGER_OPTIONS)],
                });
                const viteBuildConfig: UserConfig = {
                    ...viteConfig,
                    build: {
                        ...viteConfig.build,
                        rollupOptions: {
                            ...viteConfig.build?.rollupOptions,
                            context,
                            // Without it, Vite drops the entry's exports, and the functions with them.
                            preserveEntrySignatures: 'strict',
                            onwarn: (warning) => {
                                warningCodes.push(warning.code);
                            },
                        },
                    },
                };
                const { errors } = await buildWithVite(viteBuildConfig);
                const bundlePath = path.resolve(outDir, 'main.js');
                const bundle = readFileSync(bundlePath);

                expect(errors).toEqual([]);
                expect(bundle).toContain(expectedEntryCall);
                expect(warningCodes).toEqual([]);
            },
        );

        // Vite's dev server passes the build options to `buildStart` without applying them.
        it('should pass this on a Vite dev server after a build, without calling moduleContext', async () => {
            const { caseDir, entry, outDir } = writeEntry('vite-dev-top-level-this');
            const moduleContextIds: string[] = [];
            const moduleContext = (id: string) => {
                moduleContextIds.push(id);
                return undefined;
            };
            const viteConfig = configVite({
                workingDir: caseDir,
                outDir,
                entry: { main: entry },
                plugins: [datadogVitePlugin(LIVE_DEBUGGER_OPTIONS)],
            });
            const viteBuildConfig: UserConfig = {
                ...viteConfig,
                build: {
                    ...viteConfig.build,
                    rollupOptions: {
                        ...viteConfig.build?.rollupOptions,
                        moduleContext,
                    },
                },
            };
            const { errors } = await buildWithVite(viteBuildConfig);
            const buildModuleContextIds = [...moduleContextIds];
            moduleContextIds.length = 0;

            const server = await createServer({
                ...viteBuildConfig,
                configFile: false,
                optimizeDeps: { noDiscovery: true },
                // Without `ws: false`, middleware mode still opens the HMR WebSocket port.
                server: { middlewareMode: true, ws: false },
            });
            try {
                const result = await server.transformRequest('/entry.js');

                expect(errors).toEqual([]);
                expect(buildModuleContextIds).toContain(entry);
                expect(moduleContextIds).toEqual([]);
                expect(result?.code).toContain('$dd_entry($dd_p0, this');
            } finally {
                await server.close();
            }
        });
    });
});
