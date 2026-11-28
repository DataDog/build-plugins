// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, rm } from '@dd/core/helpers/fs';
import os from 'os';
import path from 'path';

import { createChatwootPhase } from './chatwoot';

const TEST_ROOT = path.resolve(os.tmpdir(), `build-plugins-canary-chatwoot-${process.pid}`);

// A function as Live Debugger instruments it, with the given function ID.
const getInstrumentedFunction = (functionId: string): string => {
    return [
        'function f() {',
        `  let $dd_p = globalThis.$dd_probes !== void 0 && $dd_probes('${functionId}');`,
        '  try { return 1; } catch ($dd_e) { if ($dd_p) $dd_throw($dd_p, $dd_e); throw $dd_e; }',
        '}',
    ].join('\n');
};

describe('Chatwoot canary target', () => {
    afterAll(async () => {
        await rm(TEST_ROOT);
    });

    test('should vary only Live Debugger settings and the output directory between builds', () => {
        const phase = createChatwootPhase();
        const control = phase.getBuildCommand('/chatwoot', 'control');
        const allFunctions = phase.getBuildCommand('/chatwoot', 'all-functions');
        const namedOnly = phase.getBuildCommand('/chatwoot', 'named-only');

        expect(control.env).toEqual({
            ...allFunctions.env,
            BUILD_PLUGIN_LIVE_DEBUGGER: 'false',
            VITE_RUBY_PUBLIC_DIR: 'public/vite-live-debugger-canary/app/control',
        });
        expect(namedOnly.env).toEqual({
            ...allFunctions.env,
            BUILD_PLUGIN_LIVE_DEBUGGER_NAMED_ONLY: 'true',
            VITE_RUBY_PUBLIC_DIR: 'public/vite-live-debugger-canary/app/named-only',
        });
        expect(allFunctions.env).toMatchObject({
            BUILD_PLUGIN_LIVE_DEBUGGER: 'true',
            BUILD_PLUGIN_LIVE_DEBUGGER_NAMED_ONLY: 'false',
            RAILS_ENV: 'production',
            // vite-plugin-ruby puts it in the URLs it emits, so it stays the same.
            VITE_RUBY_PUBLIC_OUTPUT_DIR: 'vite',
        });
        expect(control.args).toEqual(allFunctions.args);
        expect(namedOnly.args).toEqual(allFunctions.args);
    });

    test('should measure the directory vite-plugin-ruby builds each variant into', () => {
        const phase = createChatwootPhase();
        const build = phase.getBuildCommand('/chatwoot', 'named-only');
        const artifacts = phase.getArtifactSpec('/chatwoot', 'named-only');
        const publicDir = build.env?.VITE_RUBY_PUBLIC_DIR ?? '';
        const publicOutputDir = build.env?.VITE_RUBY_PUBLIC_OUTPUT_DIR ?? '';

        // vite-plugin-ruby ignores --outDir, and writes to <publicDir>/<publicOutputDir>.
        expect(build.args).not.toContain('--outDir');
        expect(publicDir).toContain('named-only');
        expect(artifacts.roots).toEqual([path.resolve('/chatwoot', publicDir, publicOutputDir)]);
    });

    test('should require instrumented functions from .vue files', async () => {
        await rm(TEST_ROOT);
        const helperPath = path.resolve(TEST_ROOT, 'helper.js');
        const componentPath = path.resolve(TEST_ROOT, 'component.js');
        await outputFile(
            helperPath,
            getInstrumentedFunction('app/javascript/shared/helpers/format.js;format'),
        );
        await outputFile(
            componentPath,
            getInstrumentedFunction('app/javascript/dashboard/App.vue;setup'),
        );
        const { assertArtifacts } = createChatwootPhase();

        await expect(assertArtifacts?.([helperPath], 'named-only')).rejects.toThrow(
            'contains no function from a .vue file',
        );
        await expect(
            assertArtifacts?.([helperPath, componentPath], 'named-only'),
        ).resolves.toBeUndefined();
    });
});
