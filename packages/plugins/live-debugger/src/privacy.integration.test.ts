// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogRspackPlugin } from '@datadog/rspack-plugin';
import { readFileSync } from '@dd/core/helpers/fs';
import type { BundlerName, Options } from '@dd/core/types';
import { getOutDir } from '@dd/tests/_jest/helpers/env';
import { defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import { buildWithRspack, configRspack } from '@dd/tools/bundlers';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import path from 'path';
import { runInNewContext } from 'vm';

// Two modules of the fixture call function declarations of columns.js while it
// waits on its own imports: registry.js through a three-module cycle, and
// mobile.js through a barrel re-exporting it.
const ENTRY = { main: './circular_project/main.js' };
const COLUMNS_FILE = 'circular_project/src/columns.js';
const SOURCE_MAP_LOADER = 'circular_project/identity-source-map-loader.cjs';

type XpackCompiler = { context: string; options: { module: { rules: object[] } } };

// Real webpack and rspack builds run a loader producing a source map before
// the Datadog plugins, which unplugin needs to chain their source maps.
const sourceMapLoaderPlugin = {
    apply(compiler: XpackCompiler) {
        const loader = path.resolve(compiler.context, SOURCE_MAP_LOADER);
        compiler.options.module.rules.unshift({ test: /\.js$/, loader });
    },
};
const XPACK_BUNDLERS: BundlerName[] = ['webpack', 'rspack'];
const OTHER_BUNDLERS: BundlerName[] = ['esbuild', 'vite', 'rollup'];

const VARIANTS = {
    baseline: {},
    privacy: { rum: { privacy: {} } },
    liveDebugger: { liveDebugger: {} },
    combined: { liveDebugger: {}, rum: { privacy: {} } },
} satisfies Record<string, Partial<Options>>;
type Variant = keyof typeof VARIANTS;
const VARIANT_NAMES: Variant[] = ['baseline', 'privacy', 'liveDebugger', 'combined'];
const INSTRUMENTED_VARIANTS: Variant[] = ['privacy', 'liveDebugger', 'combined'];

// The production build that exposed the issue: concatenated modules, minified.
const RSPACK_PRODUCTION = 'rspack-production';
type Target = BundlerName | typeof RSPACK_PRODUCTION;
const TARGETS: { name: Target }[] = BUNDLERS.map(({ name }) => ({ name }));
if (BUNDLERS.some(({ name }) => name === 'rspack')) {
    TARGETS.push({ name: RSPACK_PRODUCTION });
}

type CellProps = { cell: { value: string } };
type CellRenderer = (props: CellProps) => string;
type CircularProject = {
    assertColumnId: (columnId: string) => string;
    cellWithLoader: (cellRenderer?: CellRenderer) => CellRenderer;
    column: { Cell: CellRenderer; width: number };
    getColumnId: () => string;
    getColumnTitle: () => string;
};

type ProbeEvent = { hook: 'entry' | 'return' | 'throw'; functionId: string };
type ProbeHandle = { functionId: string };
type BundleGlobals = {
    circularProject?: CircularProject;
    $DD_A_Q?: string[][];
    $dd_probes?: (functionId: string) => ProbeHandle;
    $dd_entry?: (handle: ProbeHandle) => ProbeHandle;
    $dd_return?: (handle: ProbeHandle, value: unknown) => unknown;
    $dd_throw?: (handle: ProbeHandle) => void;
};

const workingDirs: Record<Variant, Partial<Record<Target, string>>> = {
    baseline: {},
    privacy: {},
    liveDebugger: {},
    combined: {},
};
const errors: string[] = [];

const getWorkingDir = (variant: Variant, target: Target) => workingDirs[variant][target] ?? '';

const getBundlePath = (variant: Variant, target: Target) => {
    const workingDir = getWorkingDir(variant, target);
    const outDir = getOutDir(workingDir, target);
    return path.resolve(outDir, 'main.js');
};

// Run the bundle in a fresh global scope and return that scope.
const loadBundle = (variant: Variant, target: Target, globals: BundleGlobals = {}) => {
    const bundlePath = getBundlePath(variant, target);
    const code = readFileSync(bundlePath);
    runInNewContext(code, globals);
    return globals;
};

const getProject = (globals: BundleGlobals): CircularProject => {
    if (!globals.circularProject) {
        throw new Error('The bundle did not expose its project.');
    }
    return globals.circularProject;
};

const getErrorMessage = (fn: () => unknown) => {
    try {
        fn();
        return undefined;
    } catch (error) {
        // Errors thrown in the bundle come from another realm.
        return String(error);
    }
};

// Everything observable from the fixture once it has been loaded.
const summarize = (project: CircularProject) => {
    const upperCaseCell = project.cellWithLoader(({ cell }) => cell.value.toUpperCase());

    return {
        cell: project.column.Cell({ cell: { value: 'loaded' } }),
        width: project.column.width,
        columnId: project.getColumnId(),
        title: project.getColumnTitle(),
        rendered: upperCaseCell({ cell: { value: 'rendered' } }),
        validColumnId: project.assertColumnId('app_version'),
        invalidColumnIdError: getErrorMessage(() => project.assertColumnId('unknown')),
    };
};

// Stand-in for the Browser Debugger SDK with an active probe on every function.
const recordProbes = (globals: BundleGlobals, events: ProbeEvent[]) => {
    globals.$dd_probes = (functionId) => ({ functionId });
    globals.$dd_entry = (handle) => {
        events.push({ hook: 'entry', functionId: handle.functionId });
        return handle;
    };
    globals.$dd_return = (handle, value) => {
        events.push({ hook: 'return', functionId: handle.functionId });
        return value;
    };
    globals.$dd_throw = (handle) => {
        events.push({ hook: 'throw', functionId: handle.functionId });
    };
};

const getProbeEvents = (variant: Variant, target: Target) => {
    // The SDK is initialized before the bundle runs, so early calls hit active probes.
    const loadEvents: ProbeEvent[] = [];
    const preloadedGlobals: BundleGlobals = {};
    recordProbes(preloadedGlobals, loadEvents);
    loadBundle(variant, target, preloadedGlobals);

    // The SDK is initialized after the bundle ran.
    const callEvents: ProbeEvent[] = [];
    const globals = loadBundle(variant, target);
    recordProbes(globals, callEvents);
    const project = getProject(globals);
    project.getColumnTitle();
    getErrorMessage(() => project.assertColumnId('unknown'));

    return { loadEvents, callEvents };
};

const getAllowlistedStrings = (variant: Variant, target: Target) => {
    // The privacy helpers file is not built under Jest, so the default helper
    // leaves each module's dictionary in the queue.
    const globals = loadBundle(variant, target);
    const dictionaries = globals.$DD_A_Q ?? [];
    return dictionaries.flat().sort();
};

const buildRspackProduction = async (workingDir: string, pluginOverrides: Partial<Options>) => {
    const outDir = getOutDir(workingDir, RSPACK_PRODUCTION);
    const plugin = datadogRspackPlugin({ ...defaultPluginOptions, ...pluginOverrides });
    const plugins = [sourceMapLoaderPlugin, plugin];
    const config = configRspack({ workingDir, outDir, entry: ENTRY, plugins });
    const result = await buildWithRspack({
        ...config,
        mode: 'production',
        optimization: { ...config.optimization, minimize: true },
    });
    return result.errors;
};

describe('Live Debugger with RUM privacy', () => {
    beforeAll(async () => {
        // Run the builds sequentially to ease the resources usage.
        for (const variant of VARIANT_NAMES) {
            const pluginOverrides = { enableGit: false, ...VARIANTS[variant] };
            const xpackOverrides = { entry: ENTRY, plugins: [sourceMapLoaderPlugin] };
            // eslint-disable-next-line no-await-in-loop
            const xpack = await runBundlers(pluginOverrides, xpackOverrides, XPACK_BUNDLERS);
            // eslint-disable-next-line no-await-in-loop
            const others = await runBundlers(pluginOverrides, { entry: ENTRY }, OTHER_BUNDLERS);
            errors.push(...xpack.errors, ...others.errors);

            for (const bundlerName of XPACK_BUNDLERS) {
                workingDirs[variant][bundlerName] = xpack.workingDir;
            }
            for (const bundlerName of OTHER_BUNDLERS) {
                workingDirs[variant][bundlerName] = others.workingDir;
            }

            if (TARGETS.some(({ name }) => name === RSPACK_PRODUCTION)) {
                workingDirs[variant][RSPACK_PRODUCTION] = xpack.workingDir;
                // eslint-disable-next-line no-await-in-loop
                const productionErrors = await buildRspackProduction(
                    xpack.workingDir,
                    pluginOverrides,
                );
                errors.push(...productionErrors);
            }
        }
    }, 300000);

    test('Should build without errors.', () => {
        expect(errors).toEqual([]);
    });

    describe.each(TARGETS)('$name', ({ name: target }) => {
        test.each(INSTRUMENTED_VARIANTS)(
            'Should keep the baseline behavior of early calls with %s.',
            (variant) => {
                const baselineGlobals = loadBundle('baseline', target);
                const baselineProject = getProject(baselineGlobals);
                const baseline = summarize(baselineProject);

                const globals = loadBundle(variant, target);
                const project = getProject(globals);
                const summary = summarize(project);

                expect(baseline.width).toBe(120);
                expect(baseline.cell).toBe('loaded');
                expect(summary).toEqual(baseline);
            },
        );

        test('Should capture probes with the same function IDs as without privacy.', () => {
            const liveDebuggerEvents = getProbeEvents('liveDebugger', target);
            const combinedEvents = getProbeEvents('combined', target);
            const functionId = (name: string) => {
                const functionIdPattern = new RegExp(`;${name}$`);
                return expect.stringMatching(functionIdPattern);
            };

            expect(liveDebuggerEvents.loadEvents).toEqual(
                expect.arrayContaining([
                    { hook: 'entry', functionId: functionId('withFallback') },
                    { hook: 'entry', functionId: functionId('cellWithLoader') },
                ]),
            );
            expect(liveDebuggerEvents.callEvents).toEqual([
                { hook: 'entry', functionId: functionId('getColumnTitle') },
                { hook: 'return', functionId: functionId('getColumnTitle') },
                { hook: 'entry', functionId: functionId('assertColumnId') },
                { hook: 'throw', functionId: functionId('assertColumnId') },
            ]);
            expect(combinedEvents).toEqual(liveDebuggerEvents);
        });

        test('Should allowlist the same strings as without the Live Debugger.', () => {
            const privacyStrings = getAllowlistedStrings('privacy', target);
            const combinedStrings = getAllowlistedStrings('combined', target);

            expect(privacyStrings).toEqual(
                expect.arrayContaining(['App version', 'Unknown column', 'app_version']),
            );
            expect(combinedStrings).toEqual(privacyStrings);
        });

        test('Should map the instrumentation back to the original function.', () => {
            const bundlePath = getBundlePath('combined', target);
            const code = readFileSync(bundlePath);
            const sourceMap = readFileSync(`${bundlePath}.map`);
            const traceMap = new TraceMap(sourceMap);

            const functionIdIndex = code.indexOf(`${COLUMNS_FILE};getColumnTitle`);
            const linesBefore = code.slice(0, functionIdIndex).split('\n');
            const original = originalPositionFor(traceMap, {
                line: linesBefore.length,
                column: linesBefore[linesBefore.length - 1].length,
            });

            const workingDir = getWorkingDir('combined', target);
            const columnsPath = path.resolve(workingDir, COLUMNS_FILE);
            const columnsLines = readFileSync(columnsPath).split('\n');
            const functionLine = columnsLines.findIndex((line) =>
                line.startsWith('export function getColumnTitle('),
            );

            expect(functionIdIndex).toBeGreaterThan(-1);
            expect(original.source).toEqual(expect.stringMatching(/columns\.js$/));
            expect(original.line).toBe(functionLine + 1);
        });
    });
});
