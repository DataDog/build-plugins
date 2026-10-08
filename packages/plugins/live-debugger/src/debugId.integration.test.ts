// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { readFile } from '@dd/core/helpers/fs';
import type { BundlerName, Options } from '@dd/core/types';
import { extractDebugId } from '@dd/error-tracking-plugin/sourcemaps/debugId';
import { getOutDir } from '@dd/tests/_jest/helpers/env';
import { hardProjectEntries } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import { glob } from 'glob';
import path from 'path';

// Captures the build metadata object literal assigned by the runtime bootstrap.
const BUILD_METADATA_RX = /globalThis\.__DD_LIVE_DEBUGGER_BUILD__=(\{[^}]*\})/g;

type ChunkOutput = {
    file: string;
    // Every build metadata object defined in the file.
    buildMetadata: unknown[];
    // The debug ID the sourcemap uploader reads from the file.
    uploadedDebugId: string | undefined;
};

const getChunkOutputs = async (outDir: string): Promise<ChunkOutput[]> => {
    const files = await glob('**/*.{js,mjs}', { cwd: outDir, absolute: true });
    const sortedFiles = files.sort();

    return Promise.all(
        sortedFiles.map(async (file) => {
            const content = await readFile(file);
            const matches = content.matchAll(BUILD_METADATA_RX);
            const buildMetadata = [...matches].map(([, serialized]) => JSON.parse(serialized));
            const uploadedDebugId = await extractDebugId(file);
            const fileName = path.basename(file);

            return { file: fileName, buildMetadata, uploadedDebugId };
        }),
    );
};

describe('Live Debugger debug IDs', () => {
    const outputs: Record<string, Partial<Record<BundlerName, ChunkOutput[]>>> = {};
    const errors: string[] = [];

    const buildProject = async (name: string, pluginOptions: Partial<Options>) => {
        const result = await runBundlers(
            { enableGit: false, liveDebugger: {}, ...pluginOptions },
            { entry: hardProjectEntries, splitting: true },
        );
        errors.push(...result.errors);

        outputs[name] = {};
        for (const { name: bundlerName } of BUNDLERS) {
            const outDir = getOutDir(result.workingDir, bundlerName);
            // eslint-disable-next-line no-await-in-loop
            outputs[name][bundlerName] = await getChunkOutputs(outDir);
        }
    };

    beforeAll(async () => {
        // Run the builds sequentially to ease the resources usage.
        await buildProject('debugIds', {
            metadata: { version: '1.0.0' },
            sourcemaps: { debugId: true },
        });
        await buildProject('noDebugIds', {});
        // Webpack can be slow to build...
    }, 200000);

    test('Should build without errors.', () => {
        expect(errors).toEqual([]);
    });

    describe.each(BUNDLERS)('$name | $version', ({ name: bundlerName }) => {
        test('Should expose the debug ID of each chunk with debug ID sourcemaps.', () => {
            const chunkOutputs = outputs.debugIds[bundlerName] ?? [];

            // Both entries and the shared or dynamic chunks.
            expect(chunkOutputs.length).toBeGreaterThan(2);
            for (const { file, buildMetadata, uploadedDebugId } of chunkOutputs) {
                expect(uploadedDebugId).toEqual(expect.any(String));
                expect({ file, buildMetadata }).toEqual({
                    file,
                    buildMetadata: [{ version: '1.0.0', debugId: uploadedDebugId }],
                });
            }
        });

        test('Should not expose a debug ID or a version when they are not configured.', () => {
            const chunkOutputs = outputs.noDebugIds[bundlerName] ?? [];

            expect(chunkOutputs.length).toBeGreaterThan(2);
            for (const { file, buildMetadata, uploadedDebugId } of chunkOutputs) {
                expect(uploadedDebugId).toBeUndefined();
                expect({ file, buildMetadata }).toEqual({ file, buildMetadata: [{}] });
            }
        });
    });
});
