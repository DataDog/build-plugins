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
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import { getMockLogger } from '@dd/tests/_jest/helpers/mocks';
import { build } from 'vite';

import type { BackendFunction } from '../backend/types';
import { generateDevVirtualEntryContent } from '../backend/virtual-entry';

import { getBaseBackendBuildConfig } from './build-config';
import { executeScriptLocally } from './local-execution';

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
});
