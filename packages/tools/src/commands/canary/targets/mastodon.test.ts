// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import path from 'path';

import { createMastodonPhase } from './mastodon';

describe('Mastodon canary target', () => {
    test('should vary only Live Debugger settings between builds', () => {
        const phase = createMastodonPhase();
        const control = phase.getBuildCommand('/mastodon', 'control');
        const allFunctions = phase.getBuildCommand('/mastodon', 'all-functions');
        const namedOnly = phase.getBuildCommand('/mastodon', 'named-only');

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
        const phase = createMastodonPhase();
        const build = phase.getBuildCommand('/mastodon', 'named-only');
        const artifacts = phase.getArtifactSpec('/mastodon', 'named-only');
        const outDirIndex = build.args.indexOf('--outDir');
        const outDir = build.args[outDirIndex + 1] ?? '';

        expect(outDirIndex).toBeGreaterThan(-1);
        // Mastodon's config sets its own Vite root, which a relative --outDir would follow.
        expect(path.isAbsolute(outDir)).toBe(true);
        expect(artifacts.roots).toEqual([outDir]);
        expect(outDir).toContain('named-only');
    });
});
