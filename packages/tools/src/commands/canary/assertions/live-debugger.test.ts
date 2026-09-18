// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, rm } from '@dd/core/helpers/fs';
import os from 'os';
import path from 'path';

import type { CommandResult } from '../types';

import { assertLiveDebuggerArtifacts, assertLiveDebuggerBuildOutput } from './live-debugger';

const TEST_ROOT = path.resolve(os.tmpdir(), `build-plugins-canary-live-debugger-${process.pid}`);

const resultWithOutput = (output: string): CommandResult => {
    return {
        durationMs: 1,
        exitCode: 0,
        output,
        signal: null,
    };
};

describe('Live Debugger canary assertions', () => {
    afterAll(async () => {
        await rm(TEST_ROOT);
    });

    test('should require positive instrumentation only from the instrumented build', () => {
        expect(() => {
            assertLiveDebuggerBuildOutput(resultWithOutput('build complete'), 'control');
        }).not.toThrow();
        expect(() => {
            assertLiveDebuggerBuildOutput(
                resultWithOutput('Live Debugger: 25/30 functions instrumented across 5/6 files'),
                'instrumented',
            );
        }).not.toThrow();
        expect(() => {
            assertLiveDebuggerBuildOutput(
                resultWithOutput('Live Debugger: 0/30 functions instrumented across 0/6 files'),
                'instrumented',
            );
        }).toThrow('did not report any Live Debugger instrumentation');
        expect(() => {
            assertLiveDebuggerBuildOutput(
                resultWithOutput('Live Debugger: 1/1 functions instrumented across 1/1 files'),
                'control',
            );
        }).toThrow('Control build unexpectedly ran Live Debugger');
    });

    test('should fail when instrumentation reports a recoverable transform error', () => {
        expect(() => {
            assertLiveDebuggerBuildOutput(
                resultWithOutput('Instrumentation Error in /consumer/app.ts: parse failed'),
                'instrumented',
            );
        }).toThrow('reported a Live Debugger error');
    });

    test('should require an emitted Live Debugger runtime marker', async () => {
        await rm(TEST_ROOT);
        const plainPath = path.resolve(TEST_ROOT, 'plain.js');
        const instrumentedPath = path.resolve(TEST_ROOT, 'instrumented.js');
        await outputFile(plainPath, 'function plain() {}');
        await outputFile(
            instrumentedPath,
            'globalThis.$dd_probes = globalThis.$dd_probes || (() => []);',
        );

        await expect(assertLiveDebuggerArtifacts([plainPath], 'instrumented')).rejects.toThrow(
            'does not contain the Live Debugger runtime marker',
        );
        await expect(
            assertLiveDebuggerArtifacts([plainPath, instrumentedPath], 'instrumented'),
        ).resolves.toBeUndefined();
    });
});
