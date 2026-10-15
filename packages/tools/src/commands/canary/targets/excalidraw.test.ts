// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';

import { allowOversizedPrecacheAssets, createExcalidrawPhase } from './excalidraw';

describe('Excalidraw canary target', () => {
    test('should vary only Live Debugger enablement between paired builds', () => {
        const phase = createExcalidrawPhase();
        const control = phase.getBuildCommand('/excalidraw', 'control');
        const instrumented = phase.getBuildCommand('/excalidraw', 'instrumented');

        expect(control.env).toEqual({
            ...instrumented.env,
            BUILD_PLUGIN_LIVE_DEBUGGER: 'false',
        });
        expect(instrumented.env?.BUILD_PLUGIN_LIVE_DEBUGGER).toBe('true');
    });

    test('should measure the same directory each variant builds into', () => {
        const phase = createExcalidrawPhase();
        const build = phase.getBuildCommand('/excalidraw', 'instrumented');
        const artifacts = phase.getArtifactSpec('/excalidraw', 'instrumented');
        const outDirIndex = build.args.indexOf('--outDir');
        const outDir = build.args[outDirIndex + 1] ?? '';
        const expectedRoot = path.resolve(build.cwd, outDir);

        expect(outDirIndex).toBeGreaterThan(-1);
        expect(artifacts.roots).toEqual([expectedRoot]);
        expect(outDir).toContain('instrumented');
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
