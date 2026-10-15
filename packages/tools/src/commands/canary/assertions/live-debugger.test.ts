// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, rm } from '@dd/core/helpers/fs';
import { runtimeStubs } from '@dd/live-debugger-plugin/runtime-bootstrap';
import { transformSync } from 'esbuild';
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

    test.each([true, false])(
        'should reject an unguarded artifact even when another artifact has a stub (guarded first: %s)',
        async (guardedFirst) => {
            const guardedPath = path.resolve(TEST_ROOT, 'guarded.js');
            const childPath = path.resolve(TEST_ROOT, 'child.js');
            await outputFile(guardedPath, `${runtimeStubs};$dd_probes("main");`);
            await outputFile(childPath, 'function child(){return $dd_probes ("child")}');
            const paths = guardedFirst ? [guardedPath, childPath] : [childPath, guardedPath];

            await expect(assertLiveDebuggerArtifacts(paths, 'instrumented')).rejects.toThrow(
                `Instrumented build output calls $dd_probes without a runtime stub: ${childPath}`,
            );
        },
    );

    test.each([
        ['formatted', transformSync(runtimeStubs).code],
        ['minified', transformSync(runtimeStubs, { minify: true }).code],
    ])('should accept guarded probe calls in %s output', async (_format, stub) => {
        const filePath = path.resolve(TEST_ROOT, 'formatted.js');
        await outputFile(filePath, `${stub}\n$dd_probes("test");`);

        await expect(
            assertLiveDebuggerArtifacts([filePath], 'instrumented'),
        ).resolves.toBeUndefined();
    });

    const unguardedChild = 'function child(){return $dd_probes("child")}';
    const guardedChild = `${runtimeStubs};${unguardedChild}`;

    test.each([
        ['a string literal', JSON.stringify(unguardedChild)],
        ['a template literal', `\`${unguardedChild}\``],
        ['an HTML srcdoc', JSON.stringify(`<script>${unguardedChild}</script>`)],
        [
            'a nested string literal',
            JSON.stringify(`${runtimeStubs};const worker = ${JSON.stringify(unguardedChild)};`),
        ],
    ])(
        'should reject unguarded code inlined as %s in a guarded artifact',
        async (_kind, payload) => {
            const filePath = path.resolve(TEST_ROOT, 'inlined.js');
            await outputFile(filePath, `${runtimeStubs};$dd_probes("main");const p=${payload};`);

            await expect(assertLiveDebuggerArtifacts([filePath], 'instrumented')).rejects.toThrow(
                `Instrumented build output inlines code that calls $dd_probes without a runtime stub: ${filePath}`,
            );
        },
    );

    test('should reject unguarded code inlined in directive position', async () => {
        const filePath = path.resolve(TEST_ROOT, 'inlined-directive.js');
        await outputFile(
            filePath,
            `${runtimeStubs};$dd_probes("main");(function(){${JSON.stringify(unguardedChild)};})();`,
        );

        await expect(assertLiveDebuggerArtifacts([filePath], 'instrumented')).rejects.toThrow(
            `Instrumented build output inlines code that calls $dd_probes without a runtime stub: ${filePath}`,
        );
    });

    test('should not let a stub inside an inlined string guard the artifact itself', async () => {
        const filePath = path.resolve(TEST_ROOT, 'masked.js');
        await outputFile(filePath, `$dd_probes("main");const p=${JSON.stringify(guardedChild)};`);

        await expect(assertLiveDebuggerArtifacts([filePath], 'instrumented')).rejects.toThrow(
            `Instrumented build output calls $dd_probes without a runtime stub: ${filePath}`,
        );
    });

    test.each([
        ['a comment', '/* call $dd_probes(id) at function entry */ function f() {}'],
        ['a member call', 'sdk.$dd_probes("x"); window.$dd_probes("y");'],
    ])('should not count %s as an unguarded probe call', async (_kind, code) => {
        const filePath = path.resolve(TEST_ROOT, 'not-a-probe-call.js');
        await outputFile(filePath, code);

        await expect(
            assertLiveDebuggerArtifacts([filePath], 'instrumented'),
        ).resolves.toBeUndefined();
    });

    test('should not let a stub inside a comment guard the artifact', async () => {
        const filePath = path.resolve(TEST_ROOT, 'comment-stub.js');
        await outputFile(filePath, '/* globalThis.$dd_probes = noop */ $dd_probes("main");');

        await expect(assertLiveDebuggerArtifacts([filePath], 'instrumented')).rejects.toThrow(
            `Instrumented build output calls $dd_probes without a runtime stub: ${filePath}`,
        );
    });

    test('should reject instrumented output it cannot parse', async () => {
        const filePath = path.resolve(TEST_ROOT, 'unparsable.js');
        await outputFile(filePath, `${runtimeStubs};$dd_probes("main");}}}`);

        await expect(assertLiveDebuggerArtifacts([filePath], 'instrumented')).rejects.toThrow(
            `Could not parse instrumented build output to check inlined code: ${filePath}`,
        );
    });

    test.each([
        ['a string literal', JSON.stringify(guardedChild)],
        ['an HTML srcdoc', JSON.stringify(`<script>${guardedChild}</script>`)],
    ])('should accept guarded code inlined as %s', async (_kind, payload) => {
        const filePath = path.resolve(TEST_ROOT, 'inlined-guarded.js');
        await outputFile(filePath, `${runtimeStubs};$dd_probes("main");const p=${payload};`);

        await expect(
            assertLiveDebuggerArtifacts([filePath], 'instrumented'),
        ).resolves.toBeUndefined();
    });
});
