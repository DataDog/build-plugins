// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseAst } from 'rollup/parseAst';

import { createParsedModuleRecord } from './ast-parsing/module-graph';
import { walkModuleGraph } from './ast-parsing/walk-module-graph';
import {
    getBackendModuleOwner,
    isBackendSourceModule,
    isPackageManagerModule,
} from './backend-sources';

const buildRoot = '/project';

describe('Backend Functions - isPackageManagerModule', () => {
    test.each([
        { modulePath: path.join('node_modules', '@datadog/apps-backend/index.js'), expected: true },
        { modulePath: path.join('..', '..', 'node_modules', 'pkg/index.js'), expected: true },
        { modulePath: path.join('.yarn', 'cache/pkg/index.js'), expected: true },
        { modulePath: path.join('src', 'node_modules_helper.ts'), expected: false },
        { modulePath: path.join('..', 'shared', 'actions.backend.ts'), expected: false },
    ])('Should return $expected for $modulePath', ({ modulePath, expected }) => {
        const isPackage = isPackageManagerModule(modulePath);
        expect(isPackage).toBe(expected);
    });
});

describe('Backend Functions - isBackendSourceModule', () => {
    test.each([
        {
            description: 'an app module',
            relativeFile: path.join('src', 'helper.ts'),
            expected: true,
        },
        {
            description: 'a module in a `..`-prefixed directory inside the root',
            relativeFile: path.join('..gen', 'helper.ts'),
            expected: true,
        },
        {
            description: 'a module outside the root',
            relativeFile: path.join('..', 'shared', 'helper.ts'),
            expected: false,
        },
        {
            description: 'a package dependency',
            relativeFile: path.join('node_modules', 'pkg', 'index.js'),
            expected: false,
        },
        {
            description: 'a non-code file',
            relativeFile: path.join('src', 'data.json'),
            expected: false,
        },
    ])('Should return $expected for $description', ({ relativeFile, expected }) => {
        const moduleId = path.join(buildRoot, relativeFile);
        const shouldTraverse = isBackendSourceModule(moduleId, buildRoot);
        expect(shouldTraverse).toBe(expected);
    });
});

/**
 * A small real tree on disk, since package ownership comes from the manifests:
 *
 *     package.json                 "monorepo", opted in, encloses the app
 *     app/                         the build root
 *       package.json
 *       node_modules/
 *         opted/                   opted in
 *         plain/                   not opted in
 *         .pnpm/opted@1.0.0/node_modules/opted/   a pnpm layout
 *     shared/                      outside the root, no manifest of its own
 */
describe('Backend Functions - package ownership rules', () => {
    const OPT_IN = { datadogApps: { backendFunctions: true } };
    let tree: string;
    let appRoot: string;
    const at = (...segments: string[]) => path.join(tree, ...segments);
    const write = (relativePath: string, contents: unknown) => {
        const file = at(relativePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(contents));
    };

    beforeAll(() => {
        tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-apps-ownership-')));
        appRoot = at('app');
        write('package.json', { name: 'monorepo', ...OPT_IN });
        write('app/package.json', { name: 'app', dependencies: { opted: '1', plain: '1' } });
        write('app/node_modules/opted/package.json', { name: 'opted', ...OPT_IN });
        write('app/node_modules/plain/package.json', { name: 'plain' });
        write('app/node_modules/.pnpm/opted@1.0.0/node_modules/opted/package.json', {
            name: 'opted',
            ...OPT_IN,
        });
    });

    afterAll(() => {
        fs.rmSync(tree, { recursive: true, force: true });
    });

    // What the library integration build doesn't already cover: a pnpm layout, and a manifest
    // enclosing the build root (the app's own or its monorepo's), which never opts anything in.
    test.each([
        {
            file: 'app/node_modules/.pnpm/opted@1.0.0/node_modules/opted/data.backend.js',
            expected: {
                kind: 'backend-package',
                package: {
                    name: 'opted',
                    root: 'app/node_modules/.pnpm/opted@1.0.0/node_modules/opted',
                },
            },
        },
        { file: 'shared/helper.ts', expected: { kind: 'other' } },
    ])('Should classify $file as $expected.kind', ({ file, expected }) => {
        const owner = getBackendModuleOwner(at(file), appRoot);

        expect(
            owner.kind === 'backend-package'
                ? {
                      ...owner,
                      package: { ...owner.package, root: path.relative(tree, owner.package.root) },
                  }
                : owner,
        ).toEqual(expected);
    });

    // A package's modules are backend source, so a dynamic import into one, whether by package
    // name or by the package's own `#` subpath import, can't be followed and fails closed.
    test.each(['opted/helper', '#internal'])(
        'Should reject a dynamic import of %s from backend code',
        (specifier) => {
            const file = at('app/node_modules/opted/hooks/state.backend.js');
            const code = `
                import { plainValue } from 'plain';
                export async function readState() {
                    const ordinary = await import('plain');
                    const { helper } = await import('${specifier}');
                    return [plainValue, ordinary, helper()];
                }
            `;
            const record = createParsedModuleRecord(file, appRoot, parseAst(code), [
                at('app/node_modules/plain/index.js'),
            ]);
            if (!record) {
                throw new Error('Expected the package module to be backend source.');
            }

            const records = new Map([[file, record]]);
            expect(() => walkModuleGraph(file, records, appRoot, () => {})).toThrow(
                `dynamic-import ${specifier}`,
            );
        },
    );
});
