// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { createFrontendProxyModules, FRONTEND_PROXY_ID_RE } from './frontend-proxy-modules';

const paths = { buildRoot: '/build', outDir: '/build/dist' };

describe('Backend Functions - frontend proxy modules', () => {
    test('Should give ids differing only in their query their own proxy modules', () => {
        const proxies = createFrontendProxyModules(() => paths);
        const plainId = '/build/b.backend.ts';
        // path.relative would normalize the query's `/../` and turn this into `b.backend.ts`.
        const queriedId = '/build/a.backend.ts?x=/../b.backend.ts';

        const plainProxyId = proxies.getProxyId(plainId);
        const queriedProxyId = proxies.getProxyId(queriedId);

        expect(queriedProxyId).not.toBe(plainProxyId);
        expect(proxies.getSourceId(plainProxyId)).toBe(plainId);
        expect(proxies.getSourceId(queriedProxyId)).toBe(queriedId);
    });

    test('Should derive the same proxy id from the same module under any build root', () => {
        const first = createFrontendProxyModules(() => paths).getProxyId('/build/src/a.backend.ts');
        const second = createFrontendProxyModules(() => ({
            buildRoot: '/elsewhere',
            outDir: '/elsewhere/dist',
        })).getProxyId('/elsewhere/src/a.backend.ts');

        expect(first).toBe(second);
        expect(first).toMatch(FRONTEND_PROXY_ID_RE);
        expect(first).not.toContain('a.backend');
    });

    test.each([
        { description: 'an unresolved import', resolved: null },
        {
            description: 'an external import',
            resolved: { id: '/build/a.backend.ts', external: true },
        },
        { description: 'an ordinary module', resolved: { id: '/build/src/helper.ts' } },
        {
            description: "a package dependency that didn't opt in to backend functions",
            resolved: { id: '/build/node_modules/pkg/a.backend.js' },
        },
        { description: 'a file in the outDir', resolved: { id: '/build/dist/a.backend.js' } },
    ])('Should leave $description as it resolved', ({ resolved }) => {
        const proxies = createFrontendProxyModules(() => paths);
        expect(proxies.resolveFrontendProxy(resolved)).toBe(resolved);
    });

    test('Should swap a backend module for its proxy module, keeping the rest of the resolution', () => {
        const proxies = createFrontendProxyModules(() => paths);
        const resolved = { id: '/build/src/a.backend.ts', moduleSideEffects: true };

        const proxy = proxies.resolveFrontendProxy(resolved);

        expect(proxy).toEqual({
            id: expect.stringMatching(FRONTEND_PROXY_ID_RE),
            moduleSideEffects: true,
        });
        expect(proxies.getSourceId(proxy?.id ?? '')).toBe(resolved.id);
    });

    test("Should swap an installed opted-in package's backend module for its proxy module", () => {
        const tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-apps-proxy-')));
        try {
            const appRoot = path.join(tree, 'app');
            const packageRoot = path.join(appRoot, 'node_modules', '@scope', 'viz');
            fs.mkdirSync(packageRoot, { recursive: true });
            const manifest = { name: '@scope/viz', datadogApps: { backendFunctions: true } };
            fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify(manifest));
            const proxies = createFrontendProxyModules(() => ({
                buildRoot: appRoot,
                outDir: path.join(appRoot, 'dist'),
            }));
            // Under the package's own dist/, as a published package ships it.
            const resolved = { id: path.join(packageRoot, 'dist', 'data.backend.js') };

            const proxy = proxies.resolveFrontendProxy(resolved);

            expect(proxy?.id).toMatch(FRONTEND_PROXY_ID_RE);
            expect(proxies.getSourceId(proxy?.id ?? '')).toBe(resolved.id);
        } finally {
            fs.rmSync(tree, { recursive: true, force: true });
        }
    });
});
