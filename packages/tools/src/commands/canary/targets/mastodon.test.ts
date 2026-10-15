// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';

import { createMastodonPhase } from './mastodon';

describe('Mastodon canary target', () => {
    test('should vary only Live Debugger enablement between paired builds', () => {
        const phase = createMastodonPhase();
        const control = phase.getBuildCommand('/mastodon', 'control');
        const instrumented = phase.getBuildCommand('/mastodon', 'instrumented');

        expect(control.env).toEqual({
            ...instrumented.env,
            BUILD_PLUGIN_LIVE_DEBUGGER: 'false',
        });
        expect(instrumented.env?.BUILD_PLUGIN_LIVE_DEBUGGER).toBe('true');
    });

    test('should measure the same directory each variant builds into', () => {
        const phase = createMastodonPhase();
        const build = phase.getBuildCommand('/mastodon', 'instrumented');
        const artifacts = phase.getArtifactSpec('/mastodon', 'instrumented');
        const outDirIndex = build.args.indexOf('--outDir');
        const outDir = build.args[outDirIndex + 1] ?? '';

        expect(outDirIndex).toBeGreaterThan(-1);
        // Mastodon's config sets its own Vite root, which a relative --outDir would follow.
        expect(path.isAbsolute(outDir)).toBe(true);
        expect(artifacts.roots).toEqual([outDir]);
        expect(outDir).toContain('instrumented');
    });
});
