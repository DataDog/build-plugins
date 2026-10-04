// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogVitePlugin } from '@datadog/vite-plugin';
import { encodeQueryName } from '@dd/apps-plugin/backend/encodeQueryName';
import { ARCHIVE_FILENAME, BACKEND_FILE_RE } from '@dd/apps-plugin/constants';
import type { AppsManifest } from '@dd/apps-plugin/types';
import { rm } from '@dd/core/helpers/fs';
import { getUniqueId } from '@dd/core/helpers/strings';
import type { BackendLibraryLayout } from '@dd/tests/_jest/helpers/appsBackendLibraryProject';
import { assembleBackendLibraryApp } from '@dd/tests/_jest/helpers/appsBackendLibraryProject';
import { getOutDir, prepareWorkingDir } from '@dd/tests/_jest/helpers/env';
import { defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { buildWithVite, configVite } from '@dd/tools/bundlers';
import fsp from 'fs/promises';
import fs from 'fs';
import JSZip from 'jszip';
import path from 'path';
import { build, createServer } from 'vite';

type Sourcemap = {
    name: string;
    sources: string[];
    sourcesContent: Array<string | null>;
};

type BackendSource = { file: string; text: string };

const FIXTURE_NAME = 'apps_backend_project';

// The functions callsBackend.ts calls, and the rest of their files' exports, which are packaged too.
const CALLED_FUNCTIONS = [
    { relativePath: `${FIXTURE_NAME}/getRuntimeUsers`, name: 'plainEcho' },
    { relativePath: `${FIXTURE_NAME}/noSdk`, name: 'noSdkFunction' },
    { relativePath: `${FIXTURE_NAME}/viaHelper`, name: 'usesHelper' },
];
const PACKAGED_FUNCTIONS = [
    ...CALLED_FUNCTIONS,
    { relativePath: `${FIXTURE_NAME}/getRuntimeUsers`, name: 'getRuntimeUsers' },
];
// Code only the backend functions' bodies (or the modules they import) contain.
const BACKEND_BODY_MARKERS = ['getExecutionUser', 'helperEcho', '@datadog/apps-backend'];
// Code only the opted-in package's backend function (or the modules it imports) contains.
const LIBRARY_BACKEND_BODY_MARKERS = [
    'viz-lib backend body',
    'toTimeseriesRequest',
    '@datadog/action-catalog',
];
const BACKEND_FILE_STEMS = ['getRuntimeUsers', 'noSdk', 'viaHelper', 'helper'];
const PROXY_CALL_RE = /executeBackendFunction\(["'`]([0-9a-f]{64}\.\w+)["'`]/g;

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

type BuildOutput = {
    maps: Sourcemap[];
    outputNames: string[];
    frontendCode: string;
    manifest: AppsManifest;
};

const readBuildOutput = async (outDir: string): Promise<BuildOutput> => {
    const maps = await readEmittedSourcemaps(outDir);
    const outputNames = await fsp.readdir(outDir, { recursive: true });
    const chunkNames = outputNames.filter((name) => name.endsWith('.js'));
    const chunks = await Promise.all(
        chunkNames.map((name) => fsp.readFile(path.join(outDir, name), 'utf-8')),
    );
    const archiveContent = await fsp.readFile(path.join(outDir, ARCHIVE_FILENAME));
    const archive = await JSZip.loadAsync(archiveContent);
    const manifestFile = archive.file('manifest.json');
    if (!manifestFile) {
        throw new Error('Expected manifest.json in the app package.');
    }
    const manifest: AppsManifest = JSON.parse(await manifestFile.async('string'));
    return { maps, outputNames, frontendCode: chunks.join('\n'), manifest };
};

const readBackendSourceFiles = async (files: string[]): Promise<BackendSource[]> => {
    const backendSources: BackendSource[] = [];
    for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        const text = await fsp.readFile(file, 'utf-8');
        backendSources.push({ file, text });
    }
    return backendSources;
};

const readBackendSources = async (fixtureDir: string): Promise<BackendSource[]> => {
    const fixtureFiles = await fsp.readdir(fixtureDir);
    const backendFiles = fixtureFiles
        .filter((file) => BACKEND_FILE_RE.test(file))
        .map((file) => path.join(fixtureDir, file));
    return readBackendSourceFiles(backendFiles);
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
        let outputNames: string[];
        let frontendCode: string;
        let manifest: AppsManifest;

        beforeAll(async () => {
            const outDir = getOutDir(workingDir, 'vite');
            const plugin = datadogVitePlugin({ ...defaultPluginOptions, apps: {} });
            const config = configVite({
                workingDir,
                outDir,
                entry: { main: `./${FIXTURE_NAME}/callsBackend.ts` },
                plugins: [plugin],
            });
            const rollupOptions = config.build?.rollupOptions ?? {};
            const output = Array.isArray(rollupOptions.output) ? {} : rollupOptions.output;
            const { errors } = await buildWithVite({
                ...config,
                build: {
                    ...config.build,
                    sourcemap: true,
                    // Vite's default chunk naming, which the test harness's own naming hides: it
                    // names a lazily imported module's chunk after the module.
                    rollupOptions: {
                        ...rollupOptions,
                        output: { ...output, chunkFileNames: '[name]-[hash].js' },
                    },
                },
            });
            if (errors.length > 0) {
                throw new Error(`Expected no build errors, got: ${errors.join(', ')}`);
            }

            ({ maps, outputNames, frontendCode, manifest } = await readBuildOutput(outDir));
        }, 60000);

        test('give the frontend a proxy call for each backend function it calls, and no backend code', () => {
            const proxiedQueryNames = [...frontendCode.matchAll(PROXY_CALL_RE)].map(
                (match) => match[1],
            );
            const calledQueryNames = CALLED_FUNCTIONS.map((func) => encodeQueryName(func));

            expect(proxiedQueryNames).toEqual(expect.arrayContaining(calledQueryNames));
            for (const marker of BACKEND_BODY_MARKERS) {
                expect(frontendCode).not.toContain(marker);
            }
        });

        test('package every backend function the frontend reaches', () => {
            const packagedQueryNames = PACKAGED_FUNCTIONS.map((func) => encodeQueryName(func));
            expect(Object.keys(manifest.backend.functions).sort()).toEqual(
                packagedQueryNames.sort(),
            );
        });

        test('never name an output file after a backend file', () => {
            const backendNamed = outputNames.filter(
                (name) =>
                    BACKEND_FILE_RE.test(name) ||
                    name.includes('.backend') ||
                    BACKEND_FILE_STEMS.some((stem) => path.basename(name).startsWith(stem)),
            );
            expect(backendNamed).toEqual([]);
        });

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

// A package that opts in ships its backend functions as `.backend.js` files under its own `dist/`,
// imported by its own package name (`@datadog/apps-frontend/visualizations/backend`). Installed
// under node_modules or linked from a checkout, it gets the same guarantees as the app's own files.
describe.each<BackendLibraryLayout>(['installed', 'linked'])(
    'apps frontend sourcemaps, for backend functions of an opted-in package (%s)',
    (layout) => {
        let cleanup: () => Promise<void>;
        let backendSources: BackendSource[];
        let output: BuildOutput;

        beforeAll(async () => {
            const assembled = await assembleBackendLibraryApp(layout);
            const { appRoot } = assembled;
            cleanup = assembled.cleanup;
            const vizLibDir = fs.realpathSync(path.join(appRoot, 'node_modules/@fixtures/viz-lib'));
            // The backend function and the module only it imports.
            backendSources = await readBackendSourceFiles([
                path.join(vizLibDir, 'dist/src/visualizations/data.backend.js'),
                path.join(vizLibDir, 'dist/src/visualizations/request.js'),
            ]);

            const plugin = datadogVitePlugin({ ...defaultPluginOptions, apps: {} });
            await build({
                root: appRoot,
                configFile: false,
                logLevel: 'silent',
                build: {
                    outDir: 'dist',
                    emptyOutDir: true,
                    sourcemap: true,
                    rollupOptions: {
                        input: path.join(appRoot, 'main.ts'),
                        // Vite's default chunk naming: it names a lazily imported module's chunk
                        // after the module, as viz-lib imports its backend function.
                        output: { chunkFileNames: '[name]-[hash].js' },
                    },
                },
                plugins: [plugin],
            });
            output = await readBuildOutput(path.join(appRoot, 'dist'));
        }, 60000);

        afterAll(async () => {
            await cleanup();
        });

        test("give the frontend a proxy call for the package's backend function, and no backend code", () => {
            const proxiedQueryNames = [...output.frontendCode.matchAll(PROXY_CALL_RE)].map(
                (match) => match[1],
            );

            expect(proxiedQueryNames).toEqual([expect.stringMatching(/\.fetchSeries$/)]);
            for (const marker of LIBRARY_BACKEND_BODY_MARKERS) {
                expect(output.frontendCode).not.toContain(marker);
            }
        });

        test("package the package's backend function the frontend reaches", () => {
            const proxiedQueryNames = [...output.frontendCode.matchAll(PROXY_CALL_RE)].map(
                (match) => match[1],
            );
            expect(Object.keys(output.manifest.backend.functions)).toEqual(proxiedQueryNames);
        });

        test('never name an output file after a backend file', () => {
            const backendNamed = output.outputNames.filter(
                (name) => BACKEND_FILE_RE.test(name) || name.includes('.backend'),
            );
            expect(backendNamed).toEqual([]);
        });

        test("still map the packages' frontend code to its sources", () => {
            const allSources = output.maps.flatMap((map) => map.sources);
            expect(allSources).toEqual(
                expect.arrayContaining([
                    expect.stringMatching(/viz-lib\/dist\/src\/index\.js$/),
                    // A package that didn't opt in keeps its `.backend.js` file an ordinary module.
                    expect.stringMatching(/plain-backend-lib\/ordinary\.backend\.js$/),
                ]),
            );
        });

        test("never reference the package's backend files as sources", () => {
            const backendSourcePaths = output.maps.flatMap((map) =>
                map.sources
                    .filter((source) => /viz-lib\/dist\/src\/visualizations\//.test(source))
                    .map((source) => `${map.name}: ${source}`),
            );
            expect(backendSourcePaths).toEqual([]);
        });

        test("never contain a backend file's source text", () => {
            expect(findBackendSourceTexts(output.maps, backendSources)).toEqual([]);
        });
    },
);
