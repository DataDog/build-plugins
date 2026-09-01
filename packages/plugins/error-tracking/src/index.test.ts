// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { readFile } from '@dd/core/helpers/fs';
import {
    DEBUG_ID_SEARCH_CHUNK_BYTES,
    extractDebugId,
} from '@dd/error-tracking-plugin/sourcemaps/debugId';
import { uploadSourcemaps } from '@dd/error-tracking-plugin/sourcemaps/index';
import { getPlugins } from '@dd/error-tracking-plugin';
import {
    getGetPluginsArg,
    getMockBuildReport,
    getSourcemapsConfiguration,
    hardProjectEntries,
} from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, runBundlers } from '@dd/tests/_jest/helpers/runBundlers';
import type { Plugin } from 'rollup';

jest.mock('@dd/error-tracking-plugin/sourcemaps/index', () => {
    return {
        uploadSourcemaps: jest.fn(),
    };
});

const uploadSourcemapsMock = jest.mocked(uploadSourcemaps);

describe('Error Tracking Plugin', () => {
    describe('getPlugins', () => {
        test('Should initialize the plugin', async () => {
            expect(getPlugins(getGetPluginsArg({ errorTracking: {} })).length).toBeGreaterThan(0);
        });
    });

    test('Should process the sourcemaps if enabled.', async () => {
        await runBundlers({
            enableGit: false,
            errorTracking: {
                sourcemaps: getSourcemapsConfiguration(),
            },
        });
        expect(uploadSourcemapsMock).toHaveBeenCalledTimes(BUNDLERS.length);
    });

    test('Should not send sourcemap upload metrics unless metrics are enabled.', async () => {
        await runBundlers({
            enableGit: false,
            errorTracking: {
                sourcemaps: getSourcemapsConfiguration(),
            },
        });

        expect(uploadSourcemapsMock.mock.calls[0][1]).toMatchObject({
            sendMetrics: false,
        });
    });

    test('Should send sourcemap upload metrics when metrics are enabled.', async () => {
        await runBundlers({
            enableGit: false,
            errorTracking: {
                sourcemaps: getSourcemapsConfiguration(),
            },
            metrics: {},
        });

        expect(uploadSourcemapsMock.mock.calls[0][1]).toMatchObject({
            sendMetrics: true,
        });
    });

    test('Should not process the sourcemaps with no options.', async () => {
        await runBundlers({
            enableGit: false,
            errorTracking: {},
        });

        expect(uploadSourcemapsMock).not.toHaveBeenCalled();
    });

    test('Should wait for artifacts and deduplicate concurrent lifecycle hooks.', async () => {
        let markArtifactsReady!: () => void;
        const artifactsReady = new Promise<void>((resolve) => {
            markArtifactsReady = resolve;
        });
        const arg = getGetPluginsArg(
            {
                enableGit: false,
                errorTracking: { sourcemaps: getSourcemapsConfiguration() },
            },
            { artifactsPending: true, artifactsReady },
        );
        const plugin = getPlugins(arg)[0];

        const buildReport = getMockBuildReport();
        const buildReportHook = plugin.buildReport!(buildReport);
        const trueEndHook = plugin.asyncTrueEnd!();
        await Promise.resolve();
        expect(uploadSourcemapsMock).not.toHaveBeenCalled();

        markArtifactsReady();
        await Promise.all([buildReportHook, trueEndHook]);
        expect(uploadSourcemapsMock).toHaveBeenCalledTimes(1);
    });

    test('Should expose all esbuild debug IDs before sourcemap upload.', async () => {
        const debugIdsAtUpload: (string | undefined)[] = [];
        uploadSourcemapsMock.mockImplementationOnce(async (_options, context) => {
            const javascriptOutputs = (context.outputs || []).filter(({ filepath }) =>
                filepath.endsWith('.js'),
            );
            const debugIds = await Promise.all(
                javascriptOutputs.map(({ filepath }) => extractDebugId(filepath)),
            );
            debugIdsAtUpload.push(...debugIds);
        });

        const { errors } = await runBundlers(
            {
                enableGit: false,
                errorTracking: { sourcemaps: getSourcemapsConfiguration() },
                rum: { sourceCodeContext: { debugId: true } },
            },
            { entry: hardProjectEntries, splitting: true },
            ['esbuild'],
        );

        expect(errors).toHaveLength(0);
        expect(debugIdsAtUpload.length).toBeGreaterThan(2);
        expect(debugIdsAtUpload).not.toContain(undefined);
    });

    test('Should keep Rollup debug IDs in the search prefix after later chunk transforms.', async () => {
        let debugIdOffsetAtUpload: number | undefined;
        uploadSourcemapsMock.mockImplementationOnce(async (_options, context) => {
            const javascriptOutput = (context.outputs || []).find(({ filepath }) =>
                filepath.endsWith('.js'),
            );
            if (!javascriptOutput) {
                return;
            }
            const content = await readFile(javascriptOutput.filepath);
            debugIdOffsetAtUpload = content.indexOf('ddDebugId');
        });

        const lateChunkTransform: Plugin = {
            name: 'late-chunk-transform',
            renderChunk(code) {
                const padding = `/*${'x'.repeat(DEBUG_ID_SEARCH_CHUNK_BYTES)}*/`;
                return `${padding}\n${code}`;
            },
        };
        const { errors } = await runBundlers(
            {
                enableGit: false,
                errorTracking: { sourcemaps: getSourcemapsConfiguration() },
                rum: { sourceCodeContext: { debugId: true } },
            },
            { plugins: [lateChunkTransform] },
            ['rollup'],
        );

        expect(errors).toHaveLength(0);
        expect(debugIdOffsetAtUpload).toBeGreaterThanOrEqual(0);
        expect(debugIdOffsetAtUpload).toBeLessThan(DEBUG_ID_SEARCH_CHUNK_BYTES);
    });
});
