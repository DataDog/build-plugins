// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Real production Vite builds of an app that consumes a stand-in `@datadog/apps-frontend`.
 *
 * The stand-in mirrors the real SDK's shape: each input consumer is a `/* @__PURE__ *\/`
 * `withInputBuildMarker(createDatadogAppInputConsumer(...), 'dd-app-input/v1 ...')` call, all
 * re-exported from a public barrel. The app imports two
 * of them through the barrel but only uses one (plus the surface-less theme input), so the
 * module graph reaches every consumer while the shipped frontend only contains the used ones.
 *
 * The SDK reaches apps in two layouts, and both are built here:
 * - workspace source: plain TS source behind a symlinked package, as web-ui consumes it;
 * - published: a minified esbuild `splitting` build of that same source, as npm consumers get it.
 */

import { datadogVitePlugin } from '@datadog/vite-plugin';
import { cleanEnv } from '@dd/tests/_jest/helpers/env';
import esbuild from 'esbuild';
import fs from 'fs/promises';
import JSZip from 'jszip';
import os from 'os';
import path from 'path';
import { build } from 'vite';

import { ARCHIVE_FILENAME } from '../constants';

const FIXTURE_ROOT = path.resolve(
    __dirname,
    '../../../../tests/src/_jest/fixtures/apps_input_surfaces',
);
const SDK_NAME = '@datadog/apps-frontend';

type SdkLayout = 'workspace source' | 'published';

/** Installs the stand-in SDK into `appRoot/node_modules` in the requested layout. */
async function installSdk(appRoot: string, layout: SdkLayout) {
    const packageDir = path.join(appRoot, 'packages', 'apps-frontend');
    await fs.cp(path.join(FIXTURE_ROOT, 'apps-frontend'), packageDir, { recursive: true });

    let exports: Record<string, string>;
    if (layout === 'workspace source') {
        exports = {
            '.': './src/index.ts',
            './inputs/schema': './src/inputs/schemas/index.ts',
        };
    } else {
        // apps-frontend's build.cjs options. Minification leaves whitespace alone because
        // esbuild's minifyWhitespace strips `/* @__PURE__ */` annotations, which would keep
        // every input (and its marker) in consumers' bundles.
        await esbuild.build({
            entryPoints: [
                path.join(packageDir, 'src/index.ts'),
                path.join(packageDir, 'src/inputs/schemas/index.ts'),
            ],
            outbase: packageDir,
            outdir: path.join(packageDir, 'dist'),
            bundle: true,
            platform: 'browser',
            target: 'es2021',
            format: 'esm',
            minifySyntax: true,
            minifyIdentifiers: true,
            splitting: true,
            chunkNames: 'src/_chunks/[name]-[hash]',
            logLevel: 'silent',
        });
        await fs.rm(path.join(packageDir, 'src'), { recursive: true });
        exports = {
            '.': './dist/src/index.js',
            './inputs/schema': './dist/src/inputs/schemas/index.js',
        };
    }

    await fs.writeFile(
        path.join(packageDir, 'package.json'),
        JSON.stringify({ name: SDK_NAME, type: 'module', exports }),
    );
    const linkPath = path.join(appRoot, 'node_modules', SDK_NAME);
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.symlink(packageDir, linkPath, 'dir');
}

const USED_SURFACED_MARKER = 'dd-app-input/v1 datadog.dashboard surfaces=';
const USED_SURFACELESS_MARKER = 'dd-app-input/v1 datadog.theme surfaces=';
const UNUSED_MARKER = 'dd-app-input/v1 datadog.service-panel surfaces=';

async function readPackage(appRoot: string) {
    const zip = await JSZip.loadAsync(
        await fs.readFile(path.join(appRoot, 'dist', ARCHIVE_FILENAME)),
    );
    const read = async (pattern: RegExp) =>
        Object.fromEntries(
            await Promise.all(
                zip.file(pattern).map(async (file) => [file.name, await file.async('string')]),
            ),
        ) as Record<string, string>;
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    const html = await zip.file('frontend/index.html')!.async('string');
    const entryScript = `frontend${html.match(/<script[^>]* src="([^"]+)"/)![1]}`;
    return {
        manifest,
        entryScript,
        scripts: await read(/^frontend\/.*\.js$/),
        sourceMaps: await read(/^frontend\/.*\.js\.map$/),
    };
}

const filesContaining = (files: Record<string, string>, text: string) =>
    Object.keys(files).filter((name) => files[name].includes(text));

/** Builds the fixture app against the SDK layout and returns its package and plugin warnings. */
async function buildApp(layout: SdkLayout) {
    const restoreEnv = cleanEnv();
    const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dd-apps-tags-'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        await fs.cp(path.join(FIXTURE_ROOT, 'app'), appRoot, { recursive: true });
        await installSdk(appRoot, layout);
        await build({
            root: appRoot,
            configFile: false,
            logLevel: 'silent',
            build: { outDir: 'dist', sourcemap: true },
            plugins: [
                datadogVitePlugin({
                    logLevel: 'warn',
                    apps: { tags: ['team:apps', 'surface:datadog.dashboard'] },
                }),
            ],
        });
        return { ...(await readPackage(appRoot)), warnings: warn.mock.calls.flat().join('\n') };
    } finally {
        warn.mockRestore();
        restoreEnv();
        await fs.rm(appRoot, { recursive: true, force: true });
    }
}

type BuiltApp = Awaited<ReturnType<typeof buildApp>>;

/** What every layout must deliver. */
function describeTagging(getApp: () => BuiltApp) {
    test('Should tag the app with its authored tags and the surfaces of the inputs it uses', () => {
        // Authored tags are kept; each surface of the dashboard input (used only from a
        // dynamically imported module) is added once; the unused and surface-less inputs add
        // nothing.
        expect(getApp().manifest.tags).toEqual([
            'surface:datadog.dashboard',
            'surface:datadog.notebook',
            'team:apps',
        ]);
    });

    test('Should ship the used inputs and drop the unused one', () => {
        // Makes the tag assertion about derivation rather than about which inputs got bundled.
        const { scripts } = getApp();
        expect(filesContaining(scripts, USED_SURFACED_MARKER)).not.toEqual([]);
        expect(filesContaining(scripts, USED_SURFACELESS_MARKER)).not.toEqual([]);
        expect(filesContaining(scripts, UNUSED_MARKER)).toEqual([]);
    });

    test('Should not warn about input markers', () => {
        expect(getApp().warnings).not.toContain('input marker');
    });
}

describe('Apps Plugin - manifest tags from a real Vite build', () => {
    describe('workspace source SDK layout', () => {
        let app: BuiltApp;
        beforeAll(async () => {
            app = await buildApp('workspace source');
        }, 60_000);

        describeTagging(() => app);

        test('Should read markers from lazily loaded chunks', () => {
            // Tree-shaking works per source module here, so the input used only by the
            // dynamically imported module lands in that module's chunk, not the entry.
            const dashboardChunks = filesContaining(app.scripts, USED_SURFACED_MARKER);
            expect(dashboardChunks).toHaveLength(1);
            expect(dashboardChunks).not.toContain(app.entryScript);
        });
    });

    describe('published SDK layout', () => {
        let app: BuiltApp;
        beforeAll(async () => {
            app = await buildApp('published');
        }, 60_000);

        describeTagging(() => app);

        test('Should ignore markers that only appear in source maps', () => {
            // The published SDK bundles every input into one shared module, whose full source the
            // package's source maps carry, unused marker included. It is neither a tag nor a
            // malformed-marker warning (as its JSON-escaped quotes would give).
            expect(filesContaining(app.sourceMaps, UNUSED_MARKER)).not.toEqual([]);
            expect(app.manifest.tags).not.toContain('surface:datadog.idp.service-panel');
            expect(app.warnings).not.toContain('input marker');
        });
    });
});
