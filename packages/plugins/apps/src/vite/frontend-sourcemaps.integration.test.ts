// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogVitePlugin } from '@datadog/vite-plugin';
import { BACKEND_FILE_RE } from '@dd/apps-plugin/constants';
import { rm } from '@dd/core/helpers/fs';
import { getUniqueId } from '@dd/core/helpers/strings';
import { getOutDir, prepareWorkingDir } from '@dd/tests/_jest/helpers/env';
import { defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { buildWithVite, configVite } from '@dd/tools/bundlers';
import fsp from 'fs/promises';
import path from 'path';
import { createServer } from 'vite';

type Sourcemap = {
    name: string;
    sources: string[];
    sourcesContent: Array<string | null>;
};

type BackendSource = { file: string; text: string };

const FIXTURE_NAME = 'apps_backend_project';

const readEmittedSourcemaps = async (outDir: string): Promise<Sourcemap[]> => {
    const entries = await fsp.readdir(outDir, { recursive: true });
    const mapFiles = entries.filter((entry) => entry.endsWith('.map'));
    const maps: Sourcemap[] = [];
    for (const file of mapFiles) {
        // eslint-disable-next-line no-await-in-loop
        const content = await fsp.readFile(path.join(outDir, file), 'utf-8');
        const { sources = [], sourcesContent = [] } = JSON.parse(content);
        maps.push({ name: file, sources, sourcesContent });
    }
    return maps;
};

const readBackendSources = async (fixtureDir: string): Promise<BackendSource[]> => {
    const fixtureFiles = await fsp.readdir(fixtureDir);
    const backendFiles = fixtureFiles.filter((file) => BACKEND_FILE_RE.test(file));
    const backendSources: BackendSource[] = [];
    for (const file of backendFiles) {
        // eslint-disable-next-line no-await-in-loop
        const text = await fsp.readFile(path.join(fixtureDir, file), 'utf-8');
        backendSources.push({ file, text });
    }
    return backendSources;
};

const findBackendSourcePaths = (maps: Sourcemap[]) =>
    maps.flatMap((map) =>
        map.sources
            .filter((source) => BACKEND_FILE_RE.test(source.split('?')[0]))
            .map((source) => `${map.name}: ${source}`),
    );

const findBackendSourceTexts = (maps: Sourcemap[], backendSources: BackendSource[]) =>
    maps.flatMap((map) =>
        backendSources
            .filter(({ text }) => map.sourcesContent.some((content) => content?.includes(text)))
            .map(({ file }) => `${map.name}: ${file}`),
    );

describe('apps frontend sourcemaps', () => {
    let workingDir: string;
    let fixtureDir: string;
    let backendSources: BackendSource[];

    beforeAll(async () => {
        const seed = `${Math.abs(jest.getSeed())}.${getUniqueId()}`;
        workingDir = await prepareWorkingDir(seed);
        fixtureDir = path.join(workingDir, FIXTURE_NAME);
        backendSources = await readBackendSources(fixtureDir);
    });

    afterAll(async () => {
        if (workingDir && !process.env.NO_CLEANUP) {
            await rm(workingDir);
        }
    });

    describe('with build.sourcemap enabled', () => {
        let maps: Sourcemap[];

        beforeAll(async () => {
            const outDir = getOutDir(workingDir, 'vite');
            const plugin = datadogVitePlugin({ ...defaultPluginOptions, apps: {} });
            const config = configVite({
                workingDir,
                outDir,
                entry: { main: `./${FIXTURE_NAME}/callsBackend.ts` },
                plugins: [plugin],
            });
            const { errors } = await buildWithVite({
                ...config,
                build: { ...config.build, sourcemap: true },
            });
            if (errors.length > 0) {
                throw new Error(`Expected no build errors, got: ${errors.join(', ')}`);
            }

            maps = await readEmittedSourcemaps(outDir);
        }, 60000);

        test('still map the frontend code to its sources', () => {
            const allSources = maps.flatMap((map) => map.sources);
            expect(allSources).toContainEqual(
                expect.stringMatching(/apps_backend_project\/callsBackend\.ts$/),
            );
        });

        test('never reference a backend file as a source', () => {
            expect(findBackendSourcePaths(maps)).toEqual([]);
        });

        test("never contain a backend file's source text", () => {
            expect(findBackendSourceTexts(maps, backendSources)).toEqual([]);
        });
    });

    describe('from the dev server', () => {
        test("serve a backend file's proxy without its source", async () => {
            const plugin = datadogVitePlugin({ ...defaultPluginOptions, apps: {} });
            const server = await createServer({
                configFile: false,
                root: fixtureDir,
                logLevel: 'silent',
                server: { middlewareMode: true, hmr: false },
                plugins: [plugin],
                optimizeDeps: { noDiscovery: true },
            });
            try {
                const served = await server.transformRequest('/noSdk.backend.ts');
                expect(served?.code).toContain('executeBackendFunction');

                const maps: Sourcemap[] = [];
                if (served?.map && 'sources' in served.map) {
                    const { sources, sourcesContent = [] } = served.map;
                    maps.push({ name: 'noSdk.backend.ts', sources, sourcesContent });
                }
                expect(findBackendSourcePaths(maps)).toEqual([]);
                expect(findBackendSourceTexts(maps, backendSources)).toEqual([]);
            } finally {
                await server.close();
            }
        });
    });
});
