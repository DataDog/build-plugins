// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';

import { allowOversizedPrecacheAssets, createExcalidrawPhase } from './excalidraw';

describe('Excalidraw canary target', () => {
    test('should vary only Live Debugger settings between builds', () => {
        const phase = createExcalidrawPhase();
        const control = phase.getBuildCommand('/excalidraw', 'control');
        const allFunctions = phase.getBuildCommand('/excalidraw', 'all-functions');
        const namedOnly = phase.getBuildCommand('/excalidraw', 'named-only');

        expect(control.env).toEqual({
            ...allFunctions.env,
            BUILD_PLUGIN_LIVE_DEBUGGER: 'false',
        });
        expect(namedOnly.env).toEqual({
            ...allFunctions.env,
            BUILD_PLUGIN_LIVE_DEBUGGER_NAMED_ONLY: 'true',
        });
        expect(allFunctions.env?.BUILD_PLUGIN_LIVE_DEBUGGER).toBe('true');
        expect(allFunctions.env?.BUILD_PLUGIN_LIVE_DEBUGGER_NAMED_ONLY).toBe('false');
    });

    test('should measure the same directory each variant builds into', () => {
        const phase = createExcalidrawPhase();
        const build = phase.getBuildCommand('/excalidraw', 'named-only');
        const artifacts = phase.getArtifactSpec('/excalidraw', 'named-only');
        const outDirIndex = build.args.indexOf('--outDir');
        const outDir = build.args[outDirIndex + 1] ?? '';
        const expectedRoot = path.resolve(build.cwd, outDir);

        expect(outDirIndex).toBeGreaterThan(-1);
        expect(artifacts.roots).toEqual([expectedRoot]);
        expect(outDir).toContain('named-only');
    });

    test('should load the same directory in Chrome that each variant builds into', () => {
        const phase = createExcalidrawPhase();
        const artifacts = phase.getArtifactSpec('/excalidraw', 'all-functions');

        expect(phase.runtime?.getServeRoot('/excalidraw', 'all-functions')).toBe(
            artifacts.roots[0],
        );
    });

    const runtimeCacheCases = [
        {
            description: 'cache Vite assets for a year',
            urlPath: '/assets/index-CR2ccv0S.js',
            expected: true,
        },
        {
            description: 'cache fonts for a year',
            urlPath: '/fonts/Virgil/Virgil-Regular.woff2',
            expected: true,
        },
        { description: 'revalidate the page', urlPath: '/index.html', expected: false },
        { description: 'revalidate the service worker', urlPath: '/sw.js', expected: false },
    ];

    test.each(runtimeCacheCases)('should $description', ({ urlPath, expected }) => {
        const phase = createExcalidrawPhase();
        expect(phase.runtime?.immutablePaths.test(urlPath)).toBe(expected);
    });

    test('should downgrade the PWA precache size error to a warning', () => {
        const config = 'plugins: [VitePWA({ registerType: "autoUpdate" })]';

        expect(allowOversizedPrecacheAssets(config)).toBe(
            'plugins: [VitePWA({ showMaximumFileSizeToCacheInBytesWarning: true, registerType: "autoUpdate" })]',
        );
    });

    const unexpectedConfigCases = [
        {
            description: 'reject a config without the PWA plugin call',
            config: 'plugins: [react()]',
            expected: 'found 0',
        },
        {
            description: 'reject a config with several PWA plugin calls',
            config: 'plugins: [VitePWA({}), VitePWA({})]',
            expected: 'found 2',
        },
    ];

    test.each(unexpectedConfigCases)('should $description', ({ config, expected }) => {
        expect(() => allowOversizedPrecacheAssets(config)).toThrow(expected);
    });
});
