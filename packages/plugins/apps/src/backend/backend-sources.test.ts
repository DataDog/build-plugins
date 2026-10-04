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
    explainExcludedBackendFile,
    findInstalledBackendFunctionPackages,
    getBackendModuleOwner,
    importsBackendFunctionPackage,
    isBackendFunctionFile,
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
 *           hooks/package.json     named sub-manifest, like preact/hooks
 *           dist/package.json      nameless, only sets "type"
 *         @scope/lib/              scoped, opted in
 *         plain/                   not opted in, depends on @scope/deep
 *         @scope/deep/             opted in, only a transitive dependency
 *         lib-alias/               "@scope/lib" installed under an alias
 *         .pnpm/opted@1.0.0/node_modules/opted/   a pnpm layout
 *         stray.backend.js         directly inside node_modules
 *     linked/                      linked from outside the root, opted in
 *       dist/package.json          nameless
 *     linked-plain/                linked from outside the root, not opted in
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
        fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
    };

    beforeAll(() => {
        tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-apps-ownership-')));
        appRoot = at('app');
        write('package.json', { name: 'monorepo', ...OPT_IN });
        write('app/package.json', {
            name: 'app',
            dependencies: { opted: '1', '@scope/lib': '1', plain: '1', 'lib-alias': '1' },
        });
        write('app/node_modules/opted/package.json', { name: 'opted', ...OPT_IN });
        write('app/node_modules/opted/hooks/package.json', { name: 'opted-hooks' });
        write('app/node_modules/opted/dist/package.json', { type: 'module' });
        write('app/node_modules/@scope/lib/package.json', { name: '@scope/lib', ...OPT_IN });
        write('app/node_modules/plain/package.json', {
            name: 'plain',
            dependencies: { '@scope/deep': '1' },
        });
        write('app/node_modules/@scope/deep/package.json', { name: '@scope/deep', ...OPT_IN });
        write('app/node_modules/lib-alias/package.json', { name: '@scope/lib', ...OPT_IN });
        write('app/node_modules/.pnpm/opted@1.0.0/node_modules/opted/package.json', {
            name: 'opted',
            ...OPT_IN,
        });
        write('app/node_modules/stray.backend.js', '');
        write('linked/package.json', { name: 'linked', ...OPT_IN });
        write('linked/dist/package.json', { type: 'module' });
        write('linked-plain/package.json', { name: 'linked-plain' });
    });

    afterAll(() => {
        fs.rmSync(tree, { recursive: true, force: true });
    });

    test.each([
        { file: 'app/src/data.backend.ts', expected: { kind: 'app' } },
        {
            file: 'app/node_modules/opted/hooks/state.backend.js',
            expected: { kind: 'backend-package', name: 'opted', root: 'app/node_modules/opted' },
        },
        {
            file: 'app/node_modules/opted/dist/data.backend.js',
            expected: { kind: 'backend-package', name: 'opted', root: 'app/node_modules/opted' },
        },
        {
            file: 'app/node_modules/@scope/lib/dist/data.backend.js',
            expected: {
                kind: 'backend-package',
                name: '@scope/lib',
                root: 'app/node_modules/@scope/lib',
            },
        },
        {
            file: 'app/node_modules/.pnpm/opted@1.0.0/node_modules/opted/data.backend.js',
            expected: {
                kind: 'backend-package',
                name: 'opted',
                root: 'app/node_modules/.pnpm/opted@1.0.0/node_modules/opted',
            },
        },
        {
            file: 'app/node_modules/plain/data.backend.js',
            expected: { kind: 'dependency', name: 'plain', root: 'app/node_modules/plain' },
        },
        { file: 'app/node_modules/stray.backend.js', expected: { kind: 'dependency' } },
        {
            file: 'linked/dist/data.backend.js',
            expected: { kind: 'backend-package', name: 'linked', root: 'linked' },
        },
        {
            file: 'linked-plain/data.backend.js',
            expected: { kind: 'linked-package', name: 'linked-plain', root: 'linked-plain' },
        },
        { file: 'shared/helper.ts', expected: { kind: 'outside-app' } },
    ])('Should classify $file as $expected.kind', ({ file, expected }) => {
        const owner = getBackendModuleOwner(at(file), appRoot);

        const pkg = 'package' in owner ? owner.package : undefined;
        expect({
            kind: owner.kind,
            ...(pkg ? { name: pkg.name, root: path.relative(tree, pkg.root) } : {}),
        }).toEqual(expected);
    });

    // Bundlers and callers spell ids differently (Vite uses forward slashes even on Windows); any
    // spelling of a path must name the same owner, since that decides what gets deployed.
    test.each([
        {
            spelling: 'with a `..` segment',
            file: 'app/node_modules/plain/../opted/data.backend.js',
        },
        { spelling: 'with a repeated separator', file: 'app/node_modules//opted/data.backend.js' },
    ])('Should classify an opted-in package file spelled $spelling by its package', ({ file }) => {
        const moduleId = `${tree}/${file}`;

        const owner = getBackendModuleOwner(moduleId, appRoot);

        expect(owner).toEqual({
            kind: 'backend-package',
            package: { name: 'opted', root: at('app/node_modules/opted') },
        });
        expect(isBackendSourceModule(moduleId, appRoot)).toBe(true);
    });

    test.each([
        { file: 'app/src/data.backend.ts', expected: true },
        { file: 'app/node_modules/opted/hooks/state.backend.js', expected: true },
        { file: 'app/node_modules/plain/data.backend.js', expected: false },
        { file: 'app/node_modules/stray.backend.js', expected: false },
        // Proxied like any linked workspace file; the graph checks then fail it closed.
        { file: 'linked-plain/data.backend.js', expected: true },
    ])('Should decide $file is a backend function file: $expected', ({ file, expected }) => {
        const isFunctionFile = isBackendFunctionFile(at(file), appRoot, at('app/dist'));
        expect(isFunctionFile).toBe(expected);
    });

    test('Should name the package and the opt-in when a linked package can provide no functions', () => {
        const file = at('linked-plain/data.backend.js');
        const explanation = explainExcludedBackendFile(file, appRoot);
        expect(explanation).toBe(
            `${file} belongs to the package "linked-plain" (${at('linked-plain')}), which doesn't ` +
                `provide backend functions. Add "datadogApps": { "backendFunctions": true } to its ` +
                `package.json, or move the file into the app.`,
        );
        const appExplanation = explainExcludedBackendFile(at('app/src/data.backend.ts'), appRoot);
        expect(appExplanation).toBeUndefined();
    });

    test.each([
        { importer: 'app/src/helper.ts', specifier: 'opted/hooks', expected: true },
        { importer: 'app/src/helper.ts', specifier: '@scope/lib/dist/x.js', expected: true },
        { importer: 'app/src/helper.ts', specifier: 'plain', expected: false },
        { importer: 'app/src/helper.ts', specifier: './local', expected: false },
        { importer: 'app/src/helper.ts', specifier: 'node:fs', expected: false },
        { importer: 'linked/dist/data.backend.js', specifier: 'linked/helper', expected: true },
    ])(
        'Should decide whether $specifier from $importer reaches a backend function package: $expected',
        ({ importer, specifier, expected }) => {
            const reaches = importsBackendFunctionPackage(specifier, at(importer), appRoot);
            expect(reaches).toBe(expected);
        },
    );

    test('Should reject a dynamic import into a backend function package from backend code', () => {
        const file = at('app/node_modules/opted/hooks/state.backend.js');
        const code = `
            import { plainValue } from 'plain';
            export async function readState() {
                const ordinary = await import('plain');
                const { helper } = await import('opted/helper');
                return [plainValue, ordinary, helper()];
            }
        `;
        const record = createParsedModuleRecord(file, appRoot, parseAst(code), [
            at('app/node_modules/plain/index.js'),
        ]);
        if (!record) {
            throw new Error('Expected the package module to be backend source.');
        }

        expect(record.unsupportedDependencies).toEqual([
            { specifier: 'opted/helper', kind: 'backend-package-dynamic-import' },
        ]);
        const records = new Map([[file, record]]);
        expect(() => walkModuleGraph(file, records, appRoot, () => {})).toThrow(
            `Unsupported dynamic import in backend code of ${file}: ${file} imports "opted/helper" dynamically, from a package that provides backend functions`,
        );
    });

    test('Should find opted-in packages anywhere in the dependency tree, with every name that reaches them', () => {
        const packages = findInstalledBackendFunctionPackages(appRoot);

        const found = packages.map(({ name, root, importNames }) => ({
            name,
            root: path.relative(tree, root),
            importNames,
        }));
        expect(found).toEqual(
            expect.arrayContaining([
                { name: 'opted', root: 'app/node_modules/opted', importNames: ['opted'] },
                {
                    name: '@scope/lib',
                    root: 'app/node_modules/@scope/lib',
                    importNames: ['@scope/lib'],
                },
                {
                    name: '@scope/lib',
                    root: 'app/node_modules/lib-alias',
                    importNames: ['@scope/lib', 'lib-alias'],
                },
                {
                    name: '@scope/deep',
                    root: 'app/node_modules/@scope/deep',
                    importNames: ['@scope/deep'],
                },
            ]),
        );
        expect(found).toHaveLength(4);
    });
});
