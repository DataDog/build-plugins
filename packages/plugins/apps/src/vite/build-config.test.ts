// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Real, unmocked build: confirms a backend function importing a real Node
// builtin (node:crypto) bundles correctly instead of being externalized.

import { outputFileSync, rmSync } from '@dd/core/helpers/fs';
import { getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import { build } from 'vite';

import { getBaseBackendBuildConfig } from './build-config';

describe('getBaseBackendBuildConfig', () => {
    test('bundles a backend function that imports a real Node builtin module with a working import, not a browser-external stub', async () => {
        const seed = `build-config-ssr-${Date.now()}`;
        const workingDir = getTempWorkingDir(seed);

        try {
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

            // The browser-external stub has no real exports and rewrites away the import specifier.
            expect(code).toContain("from 'node:crypto'");
            expect(code).not.toContain('__vite-browser-external');
        } finally {
            rmSync(workingDir);
        }
    });
});
