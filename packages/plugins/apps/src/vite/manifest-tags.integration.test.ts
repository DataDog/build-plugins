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

async function readPackage(appRoot: string) {
    const zip = await JSZip.loadAsync(
        await fs.readFile(path.join(appRoot, 'dist', ARCHIVE_FILENAME)),
    );
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    const frontendScripts = await Promise.all(
        zip
            .file(/^frontend\/.*\.js$/)
            .filter((file) => !file.name.endsWith('.map'))
            .map((file) => file.async('string')),
    );
    return { manifest, frontendCode: frontendScripts.join('\n') };
}

describe('Apps Plugin - manifest tags from a real Vite build', () => {
    let appRoot: string;
    let restoreEnv: () => void;

    beforeEach(async () => {
        restoreEnv = cleanEnv();
        appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dd-apps-tags-'));
        await fs.cp(path.join(FIXTURE_ROOT, 'app'), appRoot, { recursive: true });
    });

    afterEach(async () => {
        restoreEnv();
        await fs.rm(appRoot, { recursive: true, force: true });
    });

    test.each<SdkLayout>(['workspace source', 'published'])(
        'Should tag the app with the surfaces of the inputs it uses, from the %s SDK layout',
        async (layout) => {
            await installSdk(appRoot, layout);

            await build({
                root: appRoot,
                configFile: false,
                logLevel: 'silent',
                build: { outDir: 'dist', sourcemap: true },
                plugins: [
                    datadogVitePlugin({
                        logLevel: 'none',
                        apps: { tags: ['team:apps', 'surface:datadog.dashboard'] },
                    }),
                ],
            });

            const { manifest, frontendCode } = await readPackage(appRoot);

            // The build really dropped the unused input and kept the surface-less one, so the
            // assertion below is about derivation rather than about an input never being bundled.
            expect(frontendCode).toContain('dd-app-input/v1 datadog.theme surfaces=');
            expect(frontendCode).not.toContain('dd-app-input/v1 datadog.service-panel');

            // Authored tags are kept; each surface of the dashboard input (used only from a
            // dynamically imported module) is added once; the unused and surface-less inputs add
            // nothing.
            expect(manifest.tags).toEqual([
                'surface:datadog.dashboard',
                'surface:datadog.notebook',
                'team:apps',
            ]);
        },
        60_000,
    );
});
