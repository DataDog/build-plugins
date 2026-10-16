// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { readFileSync } from '@dd/core/helpers/fs';
import type { BundlerName } from '@dd/core/types';
import { getOutDir } from '@dd/tests/_jest/helpers/env';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import fs from 'fs';
import path from 'path';
import { runInNewContext } from 'vm';

// Instrumented code that runs in another global scope than the page's chunks:
// none of these get the chunk bootstrap's `$dd_probes` stub for sure, so each
// one must run where `$dd_probes` was never defined.
const MAIN_ENTRY = './realms_project/main.js';
const WORKER_ENTRY = './realms_project/worker_main.js';
const CHILD_ENTRY = './realms_project/src/child.js';
const EXPECTED_RESULT = 42;

const PROBES_CALL = /\$dd_probes\(/;
const PROBES_STUB = /globalThis\.\$dd_probes\s*=\s*function/;

type CompilerRun = (callback: (error?: Error | null, stats?: CompilerStats) => void) => void;
type CompilerStats = { hasErrors(): boolean; toString(): string };
type XpackCompiler = {
    context: string;
    options: { output: { path?: string }; module: { rules: object[] } };
    webpack: ((options: object) => { run: CompilerRun; close(callback: () => void): void }) & {
        EntryPlugin: new (context: string, entry: string, options: { name: string }) => object;
    };
    hooks: {
        afterEmit: { tapPromise(name: string, fn: () => Promise<void>): void };
        make: {
            tapAsync(
                name: string,
                fn: (compilation: XpackCompilation, callback: (error?: Error) => void) => void,
            ): void;
        };
    };
};
type XpackCompilation = {
    createChildCompiler(
        name: string,
        outputOptions: { filename: string },
        plugins: object[],
    ): { runAsChild(callback: (error?: Error | null) => void): void };
};

// Like web-ui's `produceChildBundle` for `?inline` imports: a new compiler that
// inherits the instrumented compiler's module rules, but not its plugins.
const separateCompilerPlugin = {
    apply(compiler: XpackCompiler) {
        compiler.hooks.afterEmit.tapPromise('realms-separate-compiler', async () => {
            const separateCompiler = compiler.webpack({
                context: compiler.context,
                mode: 'none',
                devtool: false,
                entry: { 'separate-compiler': CHILD_ENTRY },
                output: { path: compiler.options.output.path, filename: '[name].js' },
                module: { rules: compiler.options.module.rules },
            });
            await new Promise<void>((resolve, reject) => {
                separateCompiler.run((error, stats) => {
                    separateCompiler.close(() => {});
                    if (error) {
                        reject(error);
                    } else if (stats?.hasErrors()) {
                        reject(new Error(stats.toString()));
                    } else {
                        resolve();
                    }
                });
            });
        });
    },
};

// Like HtmlWebpackPlugin or Workbox: a child compiler of the instrumented compilation.
const childCompilerPlugin = {
    apply(compiler: XpackCompiler) {
        compiler.hooks.make.tapAsync('realms-child-compiler', (compilation, callback) => {
            const { EntryPlugin } = compiler.webpack;
            const childCompiler = compilation.createChildCompiler(
                'realms-child-compiler',
                { filename: '[name].js' },
                [new EntryPlugin(compiler.context, CHILD_ENTRY, { name: 'child-compiler' })],
            );
            childCompiler.runAsChild((error) => callback(error ?? undefined));
        });
    },
};

type Scenario = {
    name: string;
    bundler: BundlerName;
    // The code that runs in its own global scope.
    getCode: () => string;
    // What the build produces today, to make changes to it visible.
    expected: { instrumented: boolean; stub: boolean };
};

type BuildRun = { bundlers: BundlerName[]; entry: Record<string, string>; plugins?: object[] };

const XPACK_BUNDLERS: BundlerName[] = ['webpack', 'rspack'];
const workingDirs: Partial<Record<BundlerName, string>> = {};
const errors: string[] = [];

const getOutputPath = (bundler: BundlerName, fileName: string) => {
    const workingDir = workingDirs[bundler] ?? '';
    return path.resolve(getOutDir(workingDir, bundler), fileName);
};

// The worker file name is chosen by the bundler.
const findWorkerOutput = (bundler: BundlerName) => {
    const outDir = path.dirname(getOutputPath(bundler, 'main.js'));
    const workerFile = fs
        .readdirSync(outDir)
        .filter((file) => file.endsWith('.js'))
        .map((file) => path.resolve(outDir, file))
        .find((file) => readFileSync(file).includes('doubleInWorker'));
    if (!workerFile) {
        throw new Error(`No worker output in ${outDir}.`);
    }
    return readFileSync(workerFile);
};

const getStringifiedSource = (bundler: BundlerName) => {
    const globals: { realmsProject?: { stringifiedSource: string } } = {};
    runInNewContext(readFileSync(getOutputPath(bundler, 'main.js')), globals);
    if (!globals.realmsProject) {
        throw new Error('The bundle did not expose its project.');
    }
    return globals.realmsProject.stringifiedSource;
};

// Run code in a fresh global scope without `$dd_probes`, like an iframe or a worker.
const runElsewhere = (code: string): unknown => {
    const globals: Record<string, unknown> = { importScripts: () => {} };
    globals.self = globals;
    const value = runInNewContext(code, globals);
    return globals.realmsResult ?? value;
};

const ALL_SCENARIOS: Scenario[] = [
    ...BUNDLERS.map(
        ({ name }): Scenario => ({
            name: 'function converted to a string',
            bundler: name,
            getCode: () => getStringifiedSource(name),
            expected: { instrumented: true, stub: false },
        }),
    ),
    ...XPACK_BUNDLERS.flatMap((bundler): Scenario[] => [
        {
            name: 'separate compiler inheriting the module rules',
            bundler,
            getCode: () => readFileSync(getOutputPath(bundler, 'separate-compiler.js')),
            expected: { instrumented: true, stub: false },
        },
        {
            name: 'child compiler',
            bundler,
            getCode: () => readFileSync(getOutputPath(bundler, 'child-compiler.js')),
            expected: { instrumented: true, stub: true },
        },
        {
            name: 'worker from new URL()',
            bundler,
            getCode: () => findWorkerOutput(bundler),
            expected: { instrumented: true, stub: true },
        },
    ]),
    {
        name: 'worker from new URL()',
        bundler: 'vite',
        getCode: () => findWorkerOutput('vite'),
        // Vite builds workers with `worker.plugins`, not the page's plugins.
        expected: { instrumented: false, stub: false },
    },
];
// Only the bundlers requested for this run.
const SCENARIOS = ALL_SCENARIOS.filter(({ bundler }) =>
    BUNDLERS.some(({ name }) => name === bundler),
);

describe('Live Debugger in other global scopes', () => {
    beforeAll(async () => {
        const pluginOverrides = { enableGit: false, liveDebugger: {} };
        const runs: BuildRun[] = [
            ...XPACK_BUNDLERS.map((bundler) => ({
                bundlers: [bundler],
                entry: { main: MAIN_ENTRY, worker_main: WORKER_ENTRY },
                plugins: [separateCompilerPlugin, childCompilerPlugin],
            })),
            { bundlers: ['vite'], entry: { main: MAIN_ENTRY, worker_main: WORKER_ENTRY } },
            { bundlers: ['esbuild', 'rollup'], entry: { main: MAIN_ENTRY } },
        ];

        // Run the builds sequentially to ease the resources usage.
        for (const { bundlers, entry, plugins } of runs) {
            // eslint-disable-next-line no-await-in-loop
            const result = await runBundlers(pluginOverrides, { entry, plugins }, bundlers);
            errors.push(...result.errors);
            for (const bundler of bundlers) {
                workingDirs[bundler] = result.workingDir;
            }
        }
    }, 300000);

    test('Should build without errors.', () => {
        expect(errors).toEqual([]);
    });

    describe.each(SCENARIOS)('$bundler: $name', ({ getCode, expected }) => {
        test('Should run where $dd_probes is not defined.', () => {
            expect(runElsewhere(getCode())).toBe(EXPECTED_RESULT);
        });

        test('Should keep the current instrumentation and stub.', () => {
            const code = getCode();

            expect({ instrumented: PROBES_CALL.test(code), stub: PROBES_STUB.test(code) }).toEqual(
                expected,
            );
        });
    });
});
