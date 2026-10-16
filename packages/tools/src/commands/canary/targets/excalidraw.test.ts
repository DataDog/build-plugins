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
