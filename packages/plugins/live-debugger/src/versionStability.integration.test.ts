// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { readFile } from '@dd/core/helpers/fs';
import { getUniqueId } from '@dd/core/helpers/strings';
import type { BundlerName } from '@dd/core/types';
import { addWorkingDir } from '@dd/tests/_jest/helpers/cleanups';
import { prepareWorkingDir } from '@dd/tests/_jest/helpers/env';
import { hardProjectEntries } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, getBundlerConfig } from '@dd/tests/_jest/helpers/runBundlers';
import { execFileSync } from 'child_process';
import { glob } from 'glob';
import path from 'path';
import type { Configuration } from 'webpack';

const BUILD_METADATA_RX = /globalThis\.__DD_LIVE_DEBUGGER_BUILD__=(\{[^}]*\})/g;
const DYNAMIC_CHUNK_MARKER = 'DYNAMIC_CHUNK_LOADED';
const LAZY_WITH_SHARED_IMPORT_MARKER = 'LAZY_WITH_SHARED_IMPORT';
const XPACK_BUNDLERS: BundlerName[] = ['webpack', 'rspack'];

type JsOutput = { file: string; content: string; injected: unknown[] };

const getJsOutputs = async (outDir: string): Promise<JsOutput[]> => {
    const files = (await glob('**/*.{js,mjs}', { cwd: outDir })).sort();
    return Promise.all(
        files.map(async (file) => {
            const content = await readFile(path.resolve(outDir, file));
            const injected = [...content.matchAll(BUILD_METADATA_RX)].map(([, serialized]) =>
                JSON.parse(serialized),
            );
            return { file, content, injected };
        }),
    );
};

// Browser-only code may throw once the injected banner has run.
const RUN_SCRIPT = `
process.on('unhandledRejection', () => {});
try { await import((await import('url')).pathToFileURL(process.argv[1]).href); } catch {}
console.log(JSON.stringify(globalThis.__DD_LIVE_DEBUGGER_BUILD__));
`;
const getRuntimeBuildMetadata = (file: string): unknown => {
    const output = execFileSync(
        process.execPath,
        ['--input-type=module', '--eval', RUN_SCRIPT, file],
        {
            encoding: 'utf-8',
            env: { PATH: process.env.PATH },
            stdio: ['ignore', 'pipe', 'ignore'],
        },
    );
    return JSON.parse(output.trim().split('\n').pop() ?? 'null');
};

describe('Build version in lazily loaded chunks', () => {
    const outputs: Record<string, Partial<Record<BundlerName, JsOutput[]>>> = {};
    const outDirs: Record<string, Partial<Record<BundlerName, string>>> = {};
    const errors: string[] = [];

    beforeAll(async () => {
        const workingDir = await prepareWorkingDir(`${Math.abs(jest.getSeed())}.${getUniqueId()}`);
        addWorkingDir(workingDir);

        // Same working directory for both builds: rspack's content hash depends on it.
        for (const version of ['1.0.0', '2.0.0']) {
            outputs[version] = {};
            outDirs[version] = {};
            for (const bundler of BUNDLERS) {
                const outDir = path.resolve(workingDir, 'dist', version, bundler.name);
                outDirs[version][bundler.name] = outDir;
                const pluginOptions = {
                    enableGit: false,
                    liveDebugger: {},
                    metadata: { version },
                    rum: { sourceCodeContext: { debugId: true as const } },
                };
                const config = getBundlerConfig(bundler.name, workingDir, pluginOptions, {
                    entry: {
                        ...hardProjectEntries,
                        worker_main: './realms_project/worker_main.js',
                        stability_main: './version_stability_project/main.js',
                        stability_main2: './version_stability_project/main2.js',
                    },
                    outDir,
                    splitting: true,
                });
                // eslint-disable-next-line no-await-in-loop
                errors.push(...(await bundler.run(workingDir, config)).errors);
                // eslint-disable-next-line no-await-in-loop
                outputs[version][bundler.name] = await getJsOutputs(outDir);
            }
        }
    }, 300000);

    test('Should build without errors.', () => {
        expect(errors).toEqual([]);
    });

    describe.each(BUNDLERS)('$name | $version', ({ name: bundlerName }) => {
        const getOutputs = (version: string) => outputs[version][bundlerName] ?? [];
        const isLazy = ({ content }: JsOutput) => content.includes(DYNAMIC_CHUNK_MARKER);

        test('Should keep lazily loaded chunks identical, with their debug IDs only.', () => {
            const lazyChunks = getOutputs('1.0.0').filter(isLazy);

            expect(lazyChunks).toHaveLength(1);
            expect(getOutputs('2.0.0').filter(isLazy)).toEqual(lazyChunks);
            for (const injected of lazyChunks[0].injected) {
                expect(injected).not.toHaveProperty('version');
            }
        });

        // With ESM, a shared chunk the entry statically imports runs first and sets the global.
        test('Should expose the version at runtime.', () => {
            const entry = path.resolve(outDirs['1.0.0'][bundlerName] ?? '', 'app1.js');
            expect(getRuntimeBuildMetadata(entry)).toMatchObject({ version: '1.0.0' });
        });

        // Rollup hashes chunks after the banner and writes the name of the imported initial chunk into the lazy one.
        test('Should keep a lazy chunk that imports initial code identical, except with rollup and vite.', () => {
            const getLazyFile = (version: string) =>
                getOutputs(version).find(({ content }) =>
                    content.includes(LAZY_WITH_SHARED_IMPORT_MARKER),
                )?.file;

            expect(getLazyFile('1.0.0')).toBeDefined();
            expect(getLazyFile('2.0.0') === getLazyFile('1.0.0')).toBe(
                !['rollup', 'vite'].includes(bundlerName),
            );
        });

        if (XPACK_BUNDLERS.includes(bundlerName)) {
            test('Should keep the version in workers.', () => {
                const workers = getOutputs('1.0.0').filter(({ content }) =>
                    content.includes('doubleInWorker'),
                );
                expect(workers.length).toBeGreaterThan(0);
                for (const { injected } of workers) {
                    expect(injected[0]).toMatchObject({ version: '1.0.0' });
                }
            });
        }
    });

    describe.each(BUNDLERS.filter(({ name }) => XPACK_BUNDLERS.includes(name)))(
        '$name | module worker',
        (bundler) => {
            // Each worker's runtime statically imports the split chunk, which runs first.
            test('Should expose the version in module workers that share a split chunk.', async () => {
                const workingDir = await prepareWorkingDir(
                    `${Math.abs(jest.getSeed())}.${getUniqueId()}`,
                );
                addWorkingDir(workingDir);
                const outDir = path.resolve(workingDir, 'dist');
                const config = getBundlerConfig(
                    bundler.name,
                    workingDir,
                    { enableGit: false, liveDebugger: {}, metadata: { version: '1.0.0' } },
                    {
                        entry: { main: './version_stability_project/module_worker_main.js' },
                        outDir,
                        splitting: true,
                    },
                ) as Configuration;
                config.experiments = { ...config.experiments, outputModule: true };
                config.output = { ...config.output, module: true, chunkFormat: 'module' };
                config.optimization = {
                    ...config.optimization,
                    splitChunks: {
                        cacheGroups: {
                            workerShared: {
                                test: /module_worker_shared/,
                                name: 'worker-shared',
                                chunks: 'all',
                                minChunks: 2,
                                minSize: 0,
                                enforce: true,
                            },
                        },
                    },
                };

                expect((await bundler.run(workingDir, config)).errors).toEqual([]);
                const jsOutputs = await getJsOutputs(outDir);
                const isWorker = ({ content }: JsOutput) => /moduleWorker2?Result =/.test(content);
                const workers = jsOutputs.filter(isWorker);
                const sharedChunk = jsOutputs.find(
                    (output) =>
                        !isWorker(output) && output.content.includes('doubleInModuleWorker'),
                );

                expect(sharedChunk).toBeDefined();
                expect(workers).toHaveLength(2);
                for (const { file } of workers) {
                    expect(getRuntimeBuildMetadata(path.resolve(outDir, file))).toMatchObject({
                        version: '1.0.0',
                    });
                }
            });
        },
    );
});
