// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { readFile } from '@dd/core/helpers/fs';
import { getUniqueId } from '@dd/core/helpers/strings';
import type { BundlerName, Options } from '@dd/core/types';
import { addWorkingDir } from '@dd/tests/_jest/helpers/cleanups';
import { prepareWorkingDir } from '@dd/tests/_jest/helpers/env';
import { hardProjectEntries } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, getBundlerConfig } from '@dd/tests/_jest/helpers/runBundlers';
import { execFileSync } from 'child_process';
import { glob } from 'glob';
import path from 'path';

// Captures the object literals assigned by the Live Debugger bootstrap and passed to the
// RUM source code context registration.
const BUILD_METADATA_RX = /globalThis\.__DD_LIVE_DEBUGGER_BUILD__=(\{[^}]*\})/g;
const SOURCE_CODE_CONTEXT_RX = /\((\{[^}]*\}),"DD_SOURCE_CODE_CONTEXT"\)/g;
// Markers of the files the tests look at.
const DYNAMIC_CHUNK_MARKER = 'DYNAMIC_CHUNK_LOADED';
const WORKER_MARKER = 'doubleInWorker';
const WORKER_ENTRY = './realms_project/worker_main.js';
const XPACK_BUNDLERS: BundlerName[] = ['webpack', 'rspack'];

type JsOutput = {
    file: string;
    content: string;
    // Every object the Live Debugger bootstrap and the RUM snippet define in the file.
    buildMetadata: unknown[];
    sourceCodeContexts: unknown[];
};

const getObjects = (content: string, rx: RegExp): unknown[] => {
    const matches = content.matchAll(rx);
    return [...matches].map(([, serialized]) => JSON.parse(serialized));
};

const getJsOutputs = async (outDir: string): Promise<JsOutput[]> => {
    const files = await glob('**/*.{js,mjs}', { cwd: outDir });
    const sortedFiles = files.sort();

    return Promise.all(
        sortedFiles.map(async (file) => {
            const absolutePath = path.resolve(outDir, file);
            const content = await readFile(absolutePath);
            const buildMetadata = getObjects(content, BUILD_METADATA_RX);
            const sourceCodeContexts = getObjects(content, SOURCE_CODE_CONTEXT_RX);
            return { file, content, buildMetadata, sourceCodeContexts };
        }),
    );
};

// Import a built file in a fresh Node process and return the Live Debugger build metadata it
// exposes. Browser-only code, like webpack's public path detection or chunk loading, may throw
// outside a browser: the injected code at the top of the files has run by then.
const RUN_ENTRY_SCRIPT = `
process.on('unhandledRejection', () => {});
const { pathToFileURL } = await import('url');
const fileUrl = pathToFileURL(process.argv[1]);
try {
    await import(fileUrl.href);
} catch (error) {
    console.error(error);
}
console.log(JSON.stringify(globalThis.__DD_LIVE_DEBUGGER_BUILD__));
`;
const getRuntimeBuildMetadata = (file: string): unknown => {
    const output = execFileSync(
        process.execPath,
        ['--input-type=module', '--eval', RUN_ENTRY_SCRIPT, file],
        { encoding: 'utf-8', env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const lines = output.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
};

const getPluginOptions = (version: string, omitVersionFromAsyncChunks: boolean) => ({
    enableGit: false,
    liveDebugger: {},
    metadata: { version },
    rum: {
        sourceCodeContext: { debugId: true as const, version, omitVersionFromAsyncChunks },
    },
});

describe('Build version in lazily loaded chunks', () => {
    // The JS outputs of each build, by bundler.
    const outputs: Record<string, Partial<Record<BundlerName, JsOutput[]>>> = {};
    const outDirs: Record<string, Partial<Record<BundlerName, string>>> = {};
    const errors: string[] = [];

    // Build every bundler into the same working directory: rspack's chunk content hash, and so
    // the debug IDs, also depends on it.
    const buildProject = async (
        workingDir: string,
        name: string,
        pluginOptions: Partial<Options>,
    ) => {
        outputs[name] = {};
        outDirs[name] = {};
        for (const bundler of BUNDLERS) {
            const outDir = path.resolve(workingDir, 'dist', name, bundler.name);
            outDirs[name][bundler.name] = outDir;
            const config = getBundlerConfig(bundler.name, workingDir, pluginOptions, {
                entry: { ...hardProjectEntries, worker_main: WORKER_ENTRY },
                outDir,
                splitting: true,
            });
            // eslint-disable-next-line no-await-in-loop
            const result = await bundler.run(workingDir, config);
            errors.push(...result.errors);
            // eslint-disable-next-line no-await-in-loop
            outputs[name][bundler.name] = await getJsOutputs(outDir);
        }
    };

    beforeAll(async () => {
        const seed = `${Math.abs(jest.getSeed())}.${getUniqueId()}`;
        const workingDir = await prepareWorkingDir(seed);
        addWorkingDir(workingDir);

        // Run the builds sequentially to ease the resources usage.
        await buildProject(workingDir, 'firstVersion', getPluginOptions('1.0.0', true));
        await buildProject(workingDir, 'secondVersion', getPluginOptions('2.0.0', true));
        await buildProject(
            workingDir,
            'secondVersionInAllChunks',
            getPluginOptions('2.0.0', false),
        );
        // Webpack can be slow to build...
    }, 300000);

    test('Should build without errors.', () => {
        expect(errors).toEqual([]);
    });

    describe.each(BUNDLERS)('$name | $version', ({ name: bundlerName }) => {
        const getOutputs = (build: string) => outputs[build][bundlerName] ?? [];
        const getDynamicChunks = (build: string) =>
            getOutputs(build).filter(({ content }) => content.includes(DYNAMIC_CHUNK_MARKER));

        test('Should keep the file name and the content of lazily loaded chunks.', () => {
            const firstChunks = getDynamicChunks('firstVersion');
            const secondChunks = getDynamicChunks('secondVersion');

            expect(firstChunks).toHaveLength(1);
            expect(secondChunks).toEqual(firstChunks);
        });

        test('Should keep the debug IDs, not the version, in lazily loaded chunks.', () => {
            const [{ buildMetadata, sourceCodeContexts }] = getDynamicChunks('firstVersion');

            expect(buildMetadata).toEqual([{ debugId: expect.any(String) }]);
            expect(sourceCodeContexts).toEqual([{ ddDebugId: expect.any(String) }]);
        });

        test('Should keep the version in lazily loaded chunks by default for RUM.', () => {
            const [firstChunk] = getDynamicChunks('firstVersion');
            const [secondChunk] = getDynamicChunks('secondVersionInAllChunks');

            expect(secondChunk.sourceCodeContexts).toEqual([
                { version: '2.0.0', ddDebugId: expect.any(String) },
            ]);
            expect(secondChunk.content).not.toEqual(firstChunk.content);
        });

        test('Should keep the version in the entries.', () => {
            const entries = getOutputs('firstVersion').filter(({ file }) =>
                ['app1.js', 'app2.js'].includes(file),
            );

            expect(entries).toHaveLength(2);
            for (const { file, buildMetadata, sourceCodeContexts } of entries) {
                expect({ file, buildMetadata, sourceCodeContexts }).toEqual({
                    file,
                    buildMetadata: [{ version: '1.0.0', debugId: expect.any(String) }],
                    sourceCodeContexts: [{ version: '1.0.0', ddDebugId: expect.any(String) }],
                });
            }
        });

        test('Should only leave the version out of files that stay identical.', () => {
            const secondOutputs = getOutputs('secondVersion');
            const filesWithoutVersion = getOutputs('firstVersion').filter(
                ({ content }) => !content.includes('1.0.0'),
            );

            // At least the lazily loaded chunk.
            expect(filesWithoutVersion.length).toBeGreaterThan(0);
            for (const output of filesWithoutVersion) {
                const secondOutput = secondOutputs.find(({ file }) => file === output.file);
                expect(secondOutput).toEqual(output);
            }
        });

        test('Should expose the version at runtime.', () => {
            const outDir = outDirs.firstVersion[bundlerName] ?? '';
            const entryFile = path.resolve(outDir, 'app1.js');
            const buildMetadata = getRuntimeBuildMetadata(entryFile);

            expect(buildMetadata).toEqual({ version: '1.0.0', debugId: expect.any(String) });
        });

        if (XPACK_BUNDLERS.includes(bundlerName)) {
            test('Should keep the version in workers, the first chunk of their realm.', () => {
                const workers = getOutputs('firstVersion').filter(({ content }) =>
                    content.includes(WORKER_MARKER),
                );

                expect(workers).toHaveLength(1);
                expect(workers[0].buildMetadata).toEqual([
                    { version: '1.0.0', debugId: expect.any(String) },
                ]);
            });
        }
    });
});
