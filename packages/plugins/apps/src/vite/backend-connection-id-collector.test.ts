// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { outputFile, rm } from '@dd/core/helpers/fs';
import { mkdtemp, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { Plugin } from 'vite';
import { build } from 'vite';

import { createBackendConnectionIdCollector } from './backend-connection-id-collector';
import { getBaseBackendBuildConfig } from './build-config';

const ACTION_CATALOG_ID = '\0action-catalog-stub';

/**
 * Stands in for `@datadog/action-catalog`, which is not installed in this repo.
 * The collector only reads the import specifier written in app source, so a
 * virtual stub is indistinguishable from the real package for this purpose —
 * and its `\0` prefix means the collector skips the stub module itself.
 */
const actionCatalogStub = (): Plugin => ({
    name: 'action-catalog-stub',
    enforce: 'pre',
    resolveId(id) {
        return id.startsWith('@datadog/action-catalog') ? ACTION_CATALOG_ID : null;
    },
    load(id) {
        return id === ACTION_CATALOG_ID ? 'export function request() { return null; }' : null;
    },
});

/**
 * Runs a real `vite.build()` over on-disk sources so the collector sees exactly
 * what a bundler hands it — post-`transform`, TypeScript already stripped.
 *
 * The unit tests feed the collector hand-written source, which cannot show
 * whether the constructs it statically matches on (the `@datadog/action-catalog`
 * import, the call site, the `connectionId` literal) actually survive Vite's
 * transform pipeline. That is the load-bearing assumption behind reading
 * `moduleInfo.code` instead of the bundler's AST, so it needs a real build.
 */
async function collectConnectionIds(files: Record<string, string>): Promise<string[]> {
    // `realpath` because macOS hands out `/var/...` temp dirs that Vite reports
    // as `/private/var/...`; the collector compares module IDs against the build
    // root as plain strings, so both sides have to agree.
    const createdRoot = await mkdtemp(path.join(tmpdir(), 'dd-apps-conn-ids-'));
    const root = await realpath(createdRoot);

    try {
        for (const [relativePath, contents] of Object.entries(files)) {
            const absolutePath = path.join(root, relativePath);
            await outputFile(absolutePath, contents);
        }

        const entryPath = path.join(root, 'entry.backend.ts');
        const collector = createBackendConnectionIdCollector(entryPath, root);
        const stub = actionCatalogStub();
        const baseConfig = getBaseBackendBuildConfig(root, {}, [collector.plugin, stub]);

        await build({
            ...baseConfig,
            build: {
                ...baseConfig.build,
                write: false,
                rollupOptions: {
                    ...baseConfig.build.rollupOptions,
                    input: { entry: entryPath },
                },
            },
        });

        return collector.getAllowedConnectionIds();
    } finally {
        await rm(root);
    }
}

describe('Backend Functions - connection ID collection through a real Vite build', () => {
    test('Should collect a connection ID written inline in the entry', async () => {
        const connectionIds = await collectConnectionIds({
            'entry.backend.ts': `
                import { request } from '@datadog/action-catalog/http/http';

                export async function run(value: string): Promise<unknown> {
                    return request({ connectionId: 'conn-inline', inputs: { value } });
                }
            `,
        });

        expect(connectionIds).toEqual(['conn-inline']);
    });

    test('Should collect connection IDs through transitive app-local modules', async () => {
        const connectionIds = await collectConnectionIds({
            'entry.backend.ts': `
                import { callDeep } from './helpers/deep';
                import { callNear } from './helpers/near';

                export async function run(): Promise<unknown> {
                    return Promise.all([callNear(), callDeep()]);
                }
            `,
            'helpers/near.ts': `
                import { request } from '@datadog/action-catalog/http/http';

                export function callNear() {
                    return request({ connectionId: 'conn-near', inputs: {} });
                }
            `,
            'helpers/deep.ts': `
                import { request } from '@datadog/action-catalog/http/http';

                import { DEEP_ID } from './ids';

                export function callDeep() {
                    return request({ connectionId: DEEP_ID, inputs: {} });
                }
            `,
            'helpers/ids.ts': `
                export const DEEP_ID = 'conn-deep';
            `,
        });

        expect(connectionIds).toEqual(['conn-deep', 'conn-near']);
    });

    test('Should resolve a connection ID that TypeScript syntax wraps and re-exports', async () => {
        const connectionIds = await collectConnectionIds({
            'entry.backend.ts': `
                import { request } from '@datadog/action-catalog/http/http';

                import { WRAPPED_ID } from './ids';

                export async function run(): Promise<unknown> {
                    return request({ connectionId: WRAPPED_ID, inputs: {} });
                }
            `,
            'ids.ts': `
                export { WRAPPED_ID } from './ids-source';
            `,
            'ids-source.ts': `
                export const WRAPPED_ID = 'conn-wrapped' as const;
            `,
        });

        expect(connectionIds).toEqual(['conn-wrapped']);
    });

    test('Should not attribute connection IDs to a module that only shares a specifier prefix', async () => {
        const connectionIds = await collectConnectionIds({
            'entry.backend.ts': `
                import { callUsed } from './helpers/used';
                import { callUsedToo } from './helpers/used.ts';

                export async function run(): Promise<unknown> {
                    return Promise.all([callUsed(), callUsedToo()]);
                }
            `,
            'helpers/used.ts': `
                import { request } from '@datadog/action-catalog/http/http';

                export function callUsed() {
                    return request({ connectionId: 'conn-used', inputs: {} });
                }

                export function callUsedToo() {
                    return request({ connectionId: 'conn-used-too', inputs: {} });
                }
            `,
        });

        expect(connectionIds).toEqual(['conn-used', 'conn-used-too']);
    });
});
