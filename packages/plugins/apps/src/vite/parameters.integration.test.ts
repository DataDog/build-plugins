// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Real production Vite builds of apps that declare parameters with a stand-in
 * `@datadog/apps-frontend/parameters`, checking what lands in manifest.json and
 * which declarations fail the build.
 *
 * Each build gets a fresh workspace: the app lives in `app/`, the build root,
 * and the stand-in SDK in the workspace's `node_modules`, so files outside
 * `app/` can stand in for a shared monorepo package.
 */

import { datadogVitePlugin } from '@datadog/vite-plugin';
import fs from 'fs/promises';
import JSZip from 'jszip';
import os from 'os';
import path from 'path';
import { build } from 'vite';

import { ARCHIVE_FILENAME } from '../constants';
import type { AppsOptions } from '../types';

const SDK_FILES = {
    'node_modules/@datadog/apps-frontend/package.json': JSON.stringify({
        name: '@datadog/apps-frontend',
        type: 'module',
        exports: { './parameters': './parameters.js', './parameters/react': './react.js' },
    }),
    'node_modules/@datadog/apps-frontend/parameters.js': `
        export function defineDatadogAppParameters(declarations) {
            return { schema: Object.keys(declarations) };
        }`,
    'node_modules/@datadog/apps-frontend/react.js': `
        export function useDatadogAppParameters(parameters) {
            return parameters.schema;
        }`,
};

const HTML =
    '<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>';

/** Builds `files` (paths relative to the workspace) and returns the packaged manifest. */
async function buildApp(files: Record<string, string>, apps: AppsOptions = {}) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'dd-apps-parameters-'));
    const appRoot = path.join(workspace, 'app');
    const quiet = [
        jest.spyOn(console, 'warn').mockImplementation(() => {}),
        jest.spyOn(console, 'error').mockImplementation(() => {}),
    ];
    try {
        const allFiles = { 'app/index.html': HTML, ...SDK_FILES, ...files };
        for (const [name, contents] of Object.entries(allFiles)) {
            const filePath = path.join(workspace, name);
            // eslint-disable-next-line no-await-in-loop
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            // eslint-disable-next-line no-await-in-loop
            await fs.writeFile(filePath, contents);
        }
        await build({
            root: appRoot,
            configFile: false,
            logLevel: 'silent',
            build: { outDir: 'dist' },
            plugins: [datadogVitePlugin({ logLevel: 'error', apps })],
        });
        const zip = await JSZip.loadAsync(
            await fs.readFile(path.join(appRoot, 'dist', ARCHIVE_FILENAME)),
        );
        const manifest = await zip.file('manifest.json')?.async('string');
        if (!manifest) {
            throw new Error('Expected manifest.json in the app package.');
        }
        return JSON.parse(manifest);
    } finally {
        for (const spy of quiet) {
            spy.mockRestore();
        }
        await fs.rm(workspace, { recursive: true, force: true });
    }
}

const ENVIRONMENT = `environment: {
    type: 'string',
    default: 'prod',
    label: 'Environment',
    options: ['prod', 'staging'],
}`;

describe('Apps Plugin - parameters from a real Vite build', () => {
    test('Should write every declaration in the app to manifest.json', async () => {
        const manifest = await buildApp({
            // Imported under another name and passed straight to the hook.
            'app/main.js': `
                import { defineDatadogAppParameters as defineParameters } from '@datadog/apps-frontend/parameters';
                import { useDatadogAppParameters } from '@datadog/apps-frontend/parameters/react';
                import { renderPanel } from './panel';

                const values = useDatadogAppParameters(defineParameters({
                    ${ENVIRONMENT},
                    limit: { type: 'number', default: -1, description: 'Rows to show' },
                }));
                renderPanel(values);`,
            // Imported as a namespace, in TypeScript, sharing one identical parameter.
            'app/panel.ts': `
                import * as parameters from '@datadog/apps-frontend/parameters';

                const panelParameters = parameters.defineDatadogAppParameters({
                    ${ENVIRONMENT},
                    compact: { type: 'boolean', default: false },
                });
                export function renderPanel(values: unknown): void {
                    document.body.dataset.parameters = JSON.stringify([values, panelParameters]);
                }`,
        });

        expect(manifest.inputSchema).toEqual({
            parameters: [
                {
                    name: 'environment',
                    type: 'STRING',
                    defaultValue: 'prod',
                    label: 'Environment',
                    enum: ['prod', 'staging'],
                },
                { name: 'limit', type: 'NUMBER', defaultValue: -1, description: 'Rows to show' },
                { name: 'compact', type: 'BOOLEAN', defaultValue: false },
            ],
        });
    });

    test('Should write an empty declaration when the app declares none', async () => {
        const manifest = await buildApp({ 'app/main.js': 'document.body.textContent = "hi";' });

        // Empty rather than absent, so the upload clears an earlier declaration.
        expect(manifest.inputSchema).toEqual({ parameters: [] });
    });

    test('Should write apps.parameters instead of anything found in code', async () => {
        const manifest = await buildApp(
            {
                // Unreadable, which would otherwise fail the build.
                'app/main.js': `
                    import { defineDatadogAppParameters } from '@datadog/apps-frontend/parameters';
                    import { shared } from './shared';
                    defineDatadogAppParameters(shared);`,
                'app/shared.js': `export const shared = { limit: { type: 'number', default: 1 } };`,
            },
            { parameters: { schema: [{ name: 'region', type: 'STRING', defaultValue: 'us' }] } },
        );

        expect(manifest.inputSchema).toEqual({
            parameters: [{ name: 'region', type: 'STRING', defaultValue: 'us' }],
        });
    });

    const IMPORT = `import { defineDatadogAppParameters } from '@datadog/apps-frontend/parameters';`;
    const LIMIT = `limit: { type: 'number', default: 10 }`;
    const declare = (body: string) => `${IMPORT}\ndefineDatadogAppParameters({ ${body} });`;
    const booleans = (from: number, to: number) =>
        Array.from(
            { length: to - from },
            (_, index) => `p${from + index}: { type: 'boolean', default: true }`,
        ).join(', ');

    test.each<[string, Record<string, string>, RegExp]>([
        [
            'a declaration held in a variable',
            { 'app/main.js': `${IMPORT}\nconst d = { ${LIMIT} };\ndefineDatadogAppParameters(d);` },
            /main\.js: passing anything other than one object literal is not supported/,
        ],
        [
            'a spread',
            {
                'app/main.js': `${IMPORT}\nconst base = {};\ndefineDatadogAppParameters({ ...base });`,
            },
            /main\.js: spreads, getters, and methods are not supported/,
        ],
        [
            'a re-export',
            {
                'app/main.js': `export { defineDatadogAppParameters } from '@datadog/apps-frontend/parameters';`,
            },
            /main\.js: re-exporting the function is not supported/,
        ],
        [
            'a dynamic import',
            { 'app/main.js': `import('@datadog/apps-frontend/parameters');` },
            /main\.js: importing the module dynamically is not supported/,
        ],
        [
            'a call through another variable',
            {
                'app/main.js': `${IMPORT}\nconst define = defineDatadogAppParameters;\ndefine({ ${LIMIT} });`,
            },
            /main\.js: using the function other than by calling it is not supported/,
        ],
        [
            'a default of the wrong type, naming its module',
            {
                'app/main.js': `import './panel.js';`,
                'app/panel.js': declare(`limit: { type: 'number', default: 'ten' }`),
            },
            /panel\.js parameter "limit" needs a number default/,
        ],
        [
            'a label that is not a string',
            { 'app/main.js': declare(`limit: { type: 'number', default: 1, label: false }`) },
            /main\.js parameter "limit": label must be a string/,
        ],
        [
            'one parameter declared differently in two modules',
            {
                'app/main.js': `${declare(LIMIT)}\nimport './panel.js';`,
                'app/panel.js': declare(`limit: { type: 'number', default: 20 }`),
            },
            /"limit" is declared differently in \S+main\.js and \S+panel\.js/,
        ],
        [
            'one parameter repeated in one declaration',
            { 'app/main.js': declare(`${LIMIT}, ${LIMIT}`) },
            /main\.js parameter "limit" is declared more than once/,
        ],
        [
            'more parameters than Datadog accepts, across modules',
            {
                'app/main.js': `${declare(booleans(0, 30))}\nimport './panel.js';`,
                'app/panel.js': declare(booleans(30, 51)),
            },
            /The app declares 51 parameters; Datadog accepts at most 50/,
        ],
        [
            'a declaration in a shared package outside the app',
            {
                'app/main.js': `import '../shared/parameters.js';`,
                'shared/parameters.js': declare(LIMIT),
            },
            /shared\/parameters\.js imports @datadog\/apps-frontend\/parameters, but the build only reads parameter declarations from the app's own/,
        ],
        [
            'a declaration in node_modules',
            {
                'app/main.js': `import 'app-settings';`,
                'app/node_modules/app-settings/package.json': JSON.stringify({
                    name: 'app-settings',
                    main: 'index.js',
                }),
                'app/node_modules/app-settings/index.js': declare(LIMIT),
            },
            /app-settings\/index\.js imports @datadog\/apps-frontend\/parameters/,
        ],
    ])('Should fail the build for %s', async (_, files, message) => {
        await expect(buildApp(files)).rejects.toThrow(message);
    });
});
