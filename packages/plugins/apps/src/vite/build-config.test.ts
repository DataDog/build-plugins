// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Real, unmocked test: getBaseBackendBuildConfig must produce a working
 * bundle for a backend function that imports a real Node built-in module
 * (e.g. node:crypto), not the browser-target `__vite-browser-external:*`
 * externalization stub Vite falls back to when `build.ssr` isn't set.
 *
 * Discovered while building a local-execution POC: without `ssr: true`,
 * Vite defaults to a browser-target build, and any `*.backend.ts` file that
 * imports a real Node built-in fails to bundle correctly -- this affects
 * dev-server.ts's existing bundleBackendFunction() today (both the current
 * cloud round-trip and any future local-execution path), not just new code.
 */

import { outputFileSync } from '@dd/core/helpers/fs';
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import { build } from 'vite';

import { getBaseBackendBuildConfig } from './build-config';

describe('getBaseBackendBuildConfig', () => {
    test('bundles a backend function that imports a real Node builtin module with a working import, not a browser-external stub', async () => {
        const workingDir = getTempWorkingDir(`build-config-ssr-${Date.now()}`);
        const absolutePath = `${workingDir}/src/usesCrypto.backend.ts`;

        outputFileSync(
            absolutePath,
            `
            import { randomBytes } from 'node:crypto';
            export async function usesCrypto() {
                return randomBytes(4).toString('hex');
            }
        `,
        );

        const virtualId = 'virtual:dd-backend-test:usesCrypto';
        const virtualContent = `import { usesCrypto } from ${JSON.stringify(absolutePath)};\nexport async function main($) { return await usesCrypto(); }`;
        const baseConfig = getBaseBackendBuildConfig(
            workingDir,
            { [virtualId]: virtualContent },
            [],
        );

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
        const code = chunk.type === 'chunk' ? chunk.code : '';

        // Without `ssr: true`, Vite externalizes node:crypto to
        // `__vite-browser-external:node:crypto`, which has no real exports --
        // calling randomBytes() from it throws at runtime, and the import
        // specifier itself is rewritten away from 'node:crypto'. Assert the
        // real, working import survived instead.
        expect(code).toContain("from 'node:crypto'");
        expect(code).not.toContain('__vite-browser-external');
    });
});
