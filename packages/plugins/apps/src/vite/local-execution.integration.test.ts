// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Real, unmocked integration test for the local-execution implementation
 * POC (.plans/high-code-apps-local-node-execution-design.md in dd-source).
 *
 * Unlike dev-server.test.ts (which mocks vite.build entirely), this test
 * uses the REAL vite.build(), REAL getBaseBackendBuildConfig, and REAL
 * generateDevVirtualEntryContent -- the exact same bundling path
 * bundleBackendFunction() in dev-server.ts uses -- then feeds that real
 * bundled output through executeScriptLocally(), proving the new local
 * execution path works against a genuine bundle, not a hand-written stand-in.
 */

import { outputFileSync } from '@dd/core/helpers/fs';
import { getTempWorkingDir, prepareWorkingDir } from '@dd/tests/_jest/helpers/env';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import { build } from 'vite';

import type { BackendFunction } from '../backend/types';
import { generateDevVirtualEntryContent } from '../backend/virtual-entry';

import { getBaseBackendBuildConfig } from './build-config';
import {
    executeScriptLocally,
    getMostRecentlyForkedChildForTest,
    killAllLocalExecutionChildren,
} from './local-execution';

const log = getMockLogger();

async function bundleRealBackendFunction(
    workingDir: string,
    functionName: string,
    sourceCode: string,
): Promise<string> {
    const absolutePath = `${workingDir}/src/${functionName}.backend.ts`;
    outputFileSync(absolutePath, sourceCode);

    const virtualId = `virtual:dd-backend-dev:${functionName}`;
    const virtualContent = generateDevVirtualEntryContent(functionName, absolutePath, workingDir);
    const baseConfig = getBaseBackendBuildConfig(workingDir, { [virtualId]: virtualContent }, []);

    const result = await build({
        ...baseConfig,
        build: {
            ...baseConfig.build,
            write: false,
            rollupOptions: {
                ...baseConfig.build.rollupOptions,
                input: virtualId,
                output: baseConfig.build.rollupOptions.output,
            },
        },
    });

    const output = Array.isArray(result) ? result[0] : result;
    if (!('output' in output)) {
        throw new Error('Unexpected vite.build result');
    }
    const chunk = output.output[0];
    return chunk.type === 'chunk' ? chunk.code : '';
}

describe('executeScriptLocally (real bundle, no mocks)', () => {
    test('runs a real Rollup-bundled *.backend.ts function locally and calls $.Actions through the local child', async () => {
        const workingDir = getTempWorkingDir(`local-exec-poc-${Date.now()}`);

        // A real sample backend function -- calls $.Actions like a customer's
        // real *.backend.ts file would, plus a genuine Node built-in import
        // (crypto) to exercise the data:-URL-import concern documented in
        // local-exec-child.js.
        const sourceCode = `
            import { randomBytes } from 'node:crypto';
            export async function greet(name) {
                const nonce = randomBytes(4).toString('hex');
                const response = await $.Actions.slack.chat.postMessage({
                    inputs: { channel: '#test', text: 'hello ' + name },
                    connectionId: 'connection:slack:poc',
                });
                return { greeting: 'hello ' + name, nonce, actionResult: response };
            }
        `;

        const code = await bundleRealBackendFunction(workingDir, 'greet', sourceCode);

        // Sanity check on the real bundle output itself, before executing it:
        // confirms Rollup actually inlined everything real-npm and left only
        // the genuine Node built-in as a bare import (the assumption
        // local-exec-child.js's data:-URL-import approach depends on).
        expect(code).toContain("from 'node:crypto'");
        expect(code).not.toContain('@datadog/action-catalog'); // not installed in this fixture -> no snippet at all
        // Rollup's preserveEntrySignatures:'exports-only' rewrites the inline
        // `export async function main($)` into a plain declaration plus a
        // separate `export { main };` -- assert on real Rollup output shape,
        // not the pre-bundling source template's shape.
        expect(code).toMatch(/async function main\(\$\)/);
        expect(code).toContain('export { main }');

        const func: BackendFunction = {
            relativePath: 'src/greet',
            name: 'greet',
            absolutePath: `${workingDir}/src/greet.backend.ts`,
            allowedConnectionIds: ['connection:slack:poc'],
        };

        const outputs = await executeScriptLocally(code, func, ['world'], log);

        // $.Actions.foo.bar(...) resolves to the raw result value directly
        // (already unwrapped from the internal {type, result} envelope) --
        // matches the real contract in shared.ts's SET_EXECUTE_ACTION_SNIPPET
        // (`return actionFn(request)`, not `return {type, result}`).
        expect(outputs.data).toMatchObject({
            greeting: 'hello world',
            actionResult: { data: null, stub: true, fqn: 'com.datadoghq.slack.chat.postMessage' },
        });
        expect((outputs.data as { nonce: string }).nonce).toMatch(/^[0-9a-f]{8}$/);
    }, 20_000);

    test('propagates a real crash (uncaught throw in the bundled function) as a rejected promise, not a hang', async () => {
        const workingDir = getTempWorkingDir(`local-exec-poc-crash-${Date.now()}`);
        const sourceCode = `
            export async function crashes() {
                throw new Error('deliberate bug in a real bundled backend function');
            }
        `;
        const code = await bundleRealBackendFunction(workingDir, 'crashes', sourceCode);

        const func: BackendFunction = {
            relativePath: 'src/crashes',
            name: 'crashes',
            absolutePath: `${workingDir}/src/crashes.backend.ts`,
            allowedConnectionIds: [],
        };

        await expect(executeScriptLocally(code, func, [], log)).rejects.toThrow(
            'deliberate bug in a real bundled backend function',
        );
    }, 20_000);

    test('returns a clean, actionable error when the backend function returns a non-serializable value (a circular reference), instead of hanging or crashing opaquely', async () => {
        const workingDir = getTempWorkingDir(`local-exec-poc-circular-${Date.now()}`);
        const sourceCode = `
            export async function circular() {
                const obj = {};
                obj.self = obj;
                return obj;
            }
        `;
        const code = await bundleRealBackendFunction(workingDir, 'circular', sourceCode);

        const func: BackendFunction = {
            relativePath: 'src/circular',
            name: 'circular',
            absolutePath: `${workingDir}/src/circular.backend.ts`,
            allowedConnectionIds: [],
        };

        await expect(executeScriptLocally(code, func, [], log)).rejects.toThrow(
            /circular|serializ/i,
        );
    }, 20_000);

    test('resolves each concurrent $.Actions call within a single execution to its own correct result, not a mixed-up one', async () => {
        const workingDir = getTempWorkingDir(`local-exec-poc-concurrent-actions-${Date.now()}`);
        const sourceCode = `
            export async function concurrentActions() {
                const [a, b, c] = await Promise.all([
                    $.Actions.slack.chat.postMessage({ inputs: { channel: '#a' }, connectionId: 'connection:slack:poc' }),
                    $.Actions.github.issues.create({ inputs: { title: 'b' }, connectionId: 'connection:slack:poc' }),
                    $.Actions.jira.jira.createIssue({ inputs: { summary: 'c' }, connectionId: 'connection:slack:poc' }),
                ]);
                return { a, b, c };
            }
        `;
        const code = await bundleRealBackendFunction(workingDir, 'concurrentActions', sourceCode);

        const func: BackendFunction = {
            relativePath: 'src/concurrentActions',
            name: 'concurrentActions',
            absolutePath: `${workingDir}/src/concurrentActions.backend.ts`,
            allowedConnectionIds: ['connection:slack:poc'],
        };

        const outputs = await executeScriptLocally(code, func, [], log);

        expect(outputs.data).toMatchObject({
            a: { stub: true, fqn: 'com.datadoghq.slack.chat.postMessage' },
            b: { stub: true, fqn: 'com.datadoghq.github.issues.create' },
            c: { stub: true, fqn: 'com.datadoghq.jira.jira.createIssue' },
        });
    }, 20_000);

    test('reports the signal when a child process is killed rather than exiting normally (e.g. an OOM-killed or crashed native module), instead of an opaque "code null" error', async () => {
        const workingDir = getTempWorkingDir(`local-exec-poc-signal-${Date.now()}`);
        // A function that never resolves -- gives the test time to kill the
        // child with a signal before it would otherwise finish or time out.
        const sourceCode = `
            export async function hangs() {
                return new Promise(() => {});
            }
        `;
        const code = await bundleRealBackendFunction(workingDir, 'hangs', sourceCode);

        const func: BackendFunction = {
            relativePath: 'src/hangs',
            name: 'hangs',
            absolutePath: `${workingDir}/src/hangs.backend.ts`,
            allowedConnectionIds: [],
        };

        const execution = executeScriptLocally(code, func, [], log, 5_000);
        const child = getMostRecentlyForkedChildForTest();
        // Give the child a moment to actually start running before killing it,
        // so this exercises a real in-flight kill, not a race with fork() itself.
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
        child?.kill('SIGSEGV');

        await expect(execution).rejects.toThrow(/SIGSEGV/);
    }, 20_000);

    test('killAllLocalExecutionChildren terminates an in-flight child (dev-server shutdown must not leave orphaned processes)', async () => {
        const workingDir = getTempWorkingDir(`local-exec-poc-shutdown-${Date.now()}`);
        const sourceCode = `
            export async function hangs() {
                return new Promise(() => {});
            }
        `;
        const code = await bundleRealBackendFunction(workingDir, 'hangs', sourceCode);

        const func: BackendFunction = {
            relativePath: 'src/hangs',
            name: 'hangs',
            absolutePath: `${workingDir}/src/hangs.backend.ts`,
            allowedConnectionIds: [],
        };

        const execution = executeScriptLocally(code, func, [], log, 5_000);
        const child = getMostRecentlyForkedChildForTest();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));

        expect(child?.killed).toBe(false);
        killAllLocalExecutionChildren();

        await expect(execution).rejects.toThrow();
        expect(child?.killed).toBe(true);
    }, 20_000);

    test('supplies a valid $.Source so @datadog/apps-backend does not throw, when the package is installed', async () => {
        // Unlike the other tests in this file (a bare temp dir with only the
        // one .backend.ts file written into it), this uses the real fixture
        // project tree, which has a real @datadog/apps-backend installed --
        // matching a real scaffolded app, and the exact condition that
        // exposed this bug: isDatadogAppsBackendInstalled(workingDir) resolves
        // true here, so generateDevVirtualEntryContent injects
        // SET_BACKEND_CONTEXT_SNIPPET, which throws unless $.Source is valid.
        const workingDir = await prepareWorkingDir(`local-exec-poc-apps-backend-${Date.now()}`);
        const sourceCode = `
            import { getExecutionUser, getInitiatingUser } from '@datadog/apps-backend/user';
            export async function usesSdk() {
                const [executionUser, initiatingUser] = await Promise.all([
                    getExecutionUser(),
                    getInitiatingUser(),
                ]);
                return { executionUser, initiatingUser };
            }
        `;
        const code = await bundleRealBackendFunction(workingDir, 'usesSdk', sourceCode);

        // Confirms the bundle actually took the @datadog/apps-backend branch
        // (the bug this test guards would otherwise be silently untested if
        // the fixture stopped resolving as installed for some other reason).
        // Asserts on the snippet's literal comment, not the imported
        // identifiers -- Rollup renames those during bundling.
        expect(code).toContain('Supply the backend runtime context');

        const func: BackendFunction = {
            relativePath: 'src/usesSdk',
            name: 'usesSdk',
            absolutePath: `${workingDir}/src/usesSdk.backend.ts`,
            allowedConnectionIds: [],
        };

        const outputs = await executeScriptLocally(code, func, [], log);

        expect(outputs.data).toMatchObject({
            executionUser: { id: 'local-dev-user', orgId: 'local-dev-org' },
            initiatingUser: { id: 'local-dev-user', orgId: 'local-dev-org' },
        });
    }, 20_000);
});
