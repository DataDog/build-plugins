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

    // Regression coverage: Vite's loadEnv() copies any VITE_-prefixed key straight out of the real
    // process.env into import.meta.env, and its `define` plugin statically inlines that value into
    // the built output at build time — completely bypassing runWithScopedEnv's runtime scoping,
    // which only wraps module execution, never this bundling step.
    test('Should not inline a VITE_-prefixed real process.env value into the built backend function', async () => {
        const seed = `build-config-env-leak-${Date.now()}`;
        const workingDir = getTempWorkingDir(seed);
        const secretKey = 'VITE_DD_TEST_REAL_SECRET';
        const secretValue = 'sk_should_never_be_inlined';
        const originalValue = process.env[secretKey];
        process.env[secretKey] = secretValue;

        try {
            const absolutePath = `${workingDir}/src/readsViteEnv.backend.ts`;

            outputFileSync(
                absolutePath,
                `
            export async function readsViteEnv() {
                return import.meta.env.${secretKey};
            }
        `,
            );

            const virtualId = 'virtual:dd-backend-test:readsViteEnv';
            const virtualContent = `import { readsViteEnv } from ${JSON.stringify(absolutePath)};\nexport async function main($) { return await readsViteEnv(); }`;
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

            expect(code).not.toContain(secretValue);
        } finally {
            if (originalValue === undefined) {
                delete process.env[secretKey];
            } else {
                process.env[secretKey] = originalValue;
            }
            rmSync(workingDir);
        }
    });

    // envPrefix: [] alone only blocks process.env — a secret that exists solely in a build root's
    // own .env file, never set on process.env at all, needs envFile: false to stay unread.
    test('Should not inline a VITE_-prefixed secret that exists only in a build root .env file', async () => {
        const seed = `build-config-dotenv-leak-${Date.now()}`;
        const workingDir = getTempWorkingDir(seed);
        const secretValue = 'sk_should_never_be_inlined_from_dotenv';

        try {
            outputFileSync(`${workingDir}/.env`, `VITE_DD_TEST_DOTENV_SECRET=${secretValue}\n`);

            const absolutePath = `${workingDir}/src/readsDotenv.backend.ts`;
            outputFileSync(
                absolutePath,
                `
            export async function readsDotenv() {
                return import.meta.env.VITE_DD_TEST_DOTENV_SECRET;
            }
        `,
            );

            const virtualId = 'virtual:dd-backend-test:readsDotenv';
            const virtualContent = `import { readsDotenv } from ${JSON.stringify(absolutePath)};\nexport async function main($) { return await readsDotenv(); }`;
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

            expect(code).not.toContain(secretValue);
        } finally {
            rmSync(workingDir);
        }
    });
});
