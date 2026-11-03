// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { datadogRspackPlugin } from '@datadog/rspack-plugin';
import { datadogWebpackPlugin } from '@datadog/webpack-plugin';
import { existsSync, mkdir, outputFile, readFile, readFileSync, rm } from '@dd/core/helpers/fs';
import type { BundlerName, Options } from '@dd/core/types';
import { getOutDir, getTempWorkingDir } from '@dd/tests/_jest/helpers/env';
import { defaultPluginOptions } from '@dd/tests/_jest/helpers/mocks';
import { BUNDLERS, getBundlerConfig } from '@dd/tests/_jest/helpers/runBundlers';
import { buildWithRspack, buildWithWebpack, configRspack, configWebpack } from '@dd/tools/bundlers';
import { execFileSync } from 'child_process';
import fsp from 'fs/promises';
import { glob } from 'glob';
import nock from 'nock';
import path from 'path';

import { SYMBOL_TABLE_PATH_ENV } from './constants';
import type { SymbolTablePayload, SymDbScope } from './symbol-table/serialize';

type XpackCompiler = { options: { module: { rules: object[] } } };

type TableFunction = {
    functionId: string;
    name: string;
    sourceFile: string;
    startLine: number | undefined;
    endLine: number | undefined;
    parentName: string | undefined;
};

// The repository root holds the git marker, the build root is its `app` directory.
const APP_DIR = 'app';
const VIRTUAL_PEER_PATH = '.yarn/__virtual__/peer-virtual-0123456789/1/packages/peer/index.js';
const XPACK_BUNDLERS: BundlerName[] = ['webpack', 'rspack'];
const PROBE_CALL_RX = /\$dd_probes\((['"`])(.*?)\1\)/g;

const PEER_SOURCE = `export function peerHello() {
    return 'hello from peer';
}
`;

const FIXTURE_FILES: Record<string, string> = {
    'app/src/main.js': `import { libGreet } from '@fixture/lib';
import { peerHello } from '../../${VIRTUAL_PEER_PATH}';
import { add, triple } from './math.js';

export const values = [1, 2].map(function (value) {
    return add(value, 1);
});

console.log(values, libGreet(), peerHello(), triple(2));
`,
    // webpack and rspack also cover a module ID with a query string.
    'app/src/main-xpack.js': `import { render } from './component.js?query';
import { values } from './main.js';

console.log(render(values.join(',')));
`,
    'app/src/math.js': `export function add(a, b) {
    const double = (value) => {
        return value * 2;
    };
    return double(a) + b;
}

export const triple = (value) =>
    value *
    3;
`,
    'app/src/component.js': `export function render(label) {
    return '<p>' + label + '</p>';
}
`,
    'packages/lib/package.json': JSON.stringify({
        name: '@fixture/lib',
        version: '1.0.0',
        main: 'index.js',
    }),
    'packages/lib/index.js': `export function libGreet() {
    return 'hello from lib';
}
`,
    'packages/peer/index.js': PEER_SOURCE,
    // Yarn PnP loads packages with peer dependencies through virtual paths.
    [VIRTUAL_PEER_PATH]: PEER_SOURCE,
};

// Real webpack and rspack builds run a loader producing a source map before the Datadog plugins,
// which unplugin needs to chain their source maps.
const SOURCE_MAP_LOADER = path.resolve(
    __dirname,
    '../../../tests/src/_jest/fixtures/circular_project/identity-source-map-loader.cjs',
);
const sourceMapLoaderPlugin = {
    apply(compiler: XpackCompiler) {
        compiler.options.module.rules.unshift({ test: /\.js$/, loader: SOURCE_MAP_LOADER });
    },
};

const PLUGIN_OVERRIDES: Partial<Options> = {
    enableGit: false,
    liveDebugger: {},
    metadata: { version: '1.0.0' },
    sourcemaps: { debugId: true },
};

const createFixture = async (workingDir: string) => {
    const writes = Object.entries(FIXTURE_FILES).map(([file, content]) => {
        const filepath = path.resolve(workingDir, file);
        return outputFile(filepath, content);
    });
    await Promise.all(writes);

    // A workspace package linked into node_modules.
    const linkPath = path.resolve(workingDir, 'app/node_modules/@fixture/lib');
    const linkTarget = path.resolve(workingDir, 'packages/lib');
    const linkDir = path.dirname(linkPath);
    await mkdir(linkDir);
    await fsp.symlink(linkTarget, linkPath, 'dir');

    // The symbol table only needs the repository root, which the `.git` entry marks.
    const gitDir = path.resolve(workingDir, '.git');
    await mkdir(gitDir);
};

// Turn the fixture into a git repository with a remote, for the upload.
const REPOSITORY_URL = 'https://github.com/DataDog/symbol-table-fixture';
const initGitRepository = (workingDir: string) => {
    const commands = [
        ['init', '-q'],
        ['remote', 'add', 'origin', REPOSITORY_URL],
        ['add', '-A'],
        [
            '-c',
            'user.name=fixture',
            '-c',
            'user.email=fixture@example.com',
            'commit',
            '-q',
            '-m',
            'init',
        ],
    ];
    for (const args of commands) {
        execFileSync('git', args, { cwd: workingDir });
    }
    const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir });
    // Git configuration can rewrite remote URLs (`insteadOf`), so read it back like the git plugin.
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: workingDir });
    return { commitSha: commitSha.toString().trim(), remoteUrl: remoteUrl.toString().trim() };
};

// Build with the symbol table dump enabled, and return the dump.
const buildWithSymbolTable = async (dumpPath: string, build: () => Promise<string[]>) => {
    process.env[SYMBOL_TABLE_PATH_ENV] = dumpPath;
    try {
        const errors = await build();
        expect(errors).toEqual([]);
    } finally {
        delete process.env[SYMBOL_TABLE_PATH_ENV];
    }

    const dump = await readFile(dumpPath);
    const table: SymbolTablePayload = JSON.parse(dump);
    return table;
};

const flattenScopes = (
    scopes: SymDbScope[] = [],
    parentName: string | undefined = undefined,
): TableFunction[] =>
    scopes.flatMap((scope) => {
        if (scope.scope_type === 'MODULE') {
            return flattenScopes(scope.scopes);
        }

        const tableFunction: TableFunction = {
            functionId: scope.language_specifics?.function_id ?? '',
            name: scope.name,
            sourceFile: scope.source_file,
            startLine: scope.start_line,
            endLine: scope.end_line,
            parentName,
        };
        const children = flattenScopes(scope.scopes, scope.name);
        return [tableFunction, ...children];
    });

const getOutputFunctionIds = async (outDir: string) => {
    const files = await glob('**/*.{js,mjs}', { cwd: outDir, absolute: true });
    const contents = files.map((file) => readFileSync(file));
    const functionIds = contents.flatMap((content) => {
        const matches = content.matchAll(PROBE_CALL_RX);
        return [...matches].map(([, , functionId]) => functionId);
    });
    return [...new Set(functionIds)].sort();
};

describe('Live Debugger symbol table', () => {
    const tables: Partial<Record<BundlerName, SymbolTablePayload>> = {};
    const outputFunctionIds: Partial<Record<BundlerName, string[]>> = {};
    const outputContents: Partial<Record<BundlerName, string[]>> = {};
    let workingDir: string;
    let appDir: string;

    beforeAll(async () => {
        const seed = `${Math.abs(jest.getSeed())}.symbol-table`;
        workingDir = getTempWorkingDir(seed);
        appDir = path.resolve(workingDir, APP_DIR);
        await createFixture(workingDir);
        const buildRoot = appDir;

        // Run the builds sequentially to ease the resources usage.
        for (const { name: bundlerName, run } of BUNDLERS) {
            const isXpack = XPACK_BUNDLERS.includes(bundlerName);
            const entry = { main: isXpack ? './src/main-xpack.js' : './src/main.js' };
            const plugins = isXpack ? [sourceMapLoaderPlugin] : [];
            const dumpPath = path.resolve(workingDir, `symbol-table.${bundlerName}.json`);
            const outDir = getOutDir(appDir, bundlerName);

            // eslint-disable-next-line no-await-in-loop
            tables[bundlerName] = await buildWithSymbolTable(dumpPath, async () => {
                const config = getBundlerConfig(bundlerName, buildRoot, PLUGIN_OVERRIDES, {
                    entry,
                    plugins,
                });
                const { errors } = await run(buildRoot, config);
                return errors;
            });
            // eslint-disable-next-line no-await-in-loop
            outputFunctionIds[bundlerName] = await getOutputFunctionIds(outDir);
            // eslint-disable-next-line no-await-in-loop
            const outputFiles = await glob('**/*', { cwd: outDir, absolute: true, nodir: true });
            outputContents[bundlerName] = outputFiles.map((file) => readFileSync(file));
        }
    }, 200000);

    afterAll(async () => {
        if (!process.env.NO_CLEANUP) {
            await rm(workingDir);
        }
    });

    describe.each(BUNDLERS)('$name | $version', ({ name: bundlerName }) => {
        const getTable = () => tables[bundlerName];
        const getFunctions = () => flattenScopes(getTable()?.scopes);
        const getFunction = (sourceFile: string, name: string) =>
            getFunctions().find(
                (tableFunction) =>
                    tableFunction.sourceFile === sourceFile && tableFunction.name === name,
            );

        test('Should list exactly the function IDs present in the output.', () => {
            const functionIds = getFunctions().map((tableFunction) => tableFunction.functionId);
            const uniqueFunctionIds = [...new Set(functionIds)].sort();

            expect(outputFunctionIds[bundlerName]?.length).toBeGreaterThan(0);
            expect(uniqueFunctionIds).toEqual(outputFunctionIds[bundlerName]);
        });

        test('Should give function IDs a path relative to the repository root.', () => {
            const functionIds = outputFunctionIds[bundlerName] ?? [];
            const unexpectedFunctionIds = functionIds.filter(
                (functionId) =>
                    functionId.includes('__virtual__') ||
                    functionId.includes('?') ||
                    functionId.startsWith('../') ||
                    path.isAbsolute(functionId),
            );

            expect(functionIds).toEqual(
                expect.arrayContaining([
                    'app/src/math.js;add',
                    'app/src/math.js;add/double',
                    'app/src/main.js;<anonymous>',
                    'packages/lib/index.js;libGreet',
                    'packages/peer/index.js;peerHello',
                ]),
            );
            expect(unexpectedFunctionIds).toEqual([]);

            // The symbol table takes the path of each function from its ID.
            const functionsInOtherFiles = getFunctions().filter(
                (tableFunction) =>
                    !tableFunction.functionId.startsWith(`${tableFunction.sourceFile};`),
            );
            expect(functionsInOtherFiles).toEqual([]);
        });

        test('Should give each function ID a single location.', () => {
            const functionIds = getFunctions().map((tableFunction) => tableFunction.functionId);
            const uniqueFunctionIds = new Set(functionIds);

            expect(functionIds.length).toBeGreaterThan(0);
            expect(uniqueFunctionIds.size).toBe(functionIds.length);
        });

        test('Should describe the build.', () => {
            const table = getTable();
            expect(table?.language).toBe('browser');
            expect(table?.version).toBe('1.0.0');
            expect(table?.chunk_debug_ids?.length).toBeGreaterThan(0);

            for (const moduleScope of table?.scopes ?? []) {
                expect(moduleScope.scope_type).toBe('MODULE');
                expect(moduleScope.start_line).toBeUndefined();
                expect(moduleScope.language_specifics?.chunk_debug_ids?.length).toBeGreaterThan(0);
            }
        });

        test('Should give paths relative to the repository root, with original line ranges.', () => {
            expect(getFunction('app/src/math.js', 'add')).toMatchObject({
                startLine: 1,
                endLine: 6,
                parentName: undefined,
            });
            expect(getFunction('app/src/math.js', 'double')).toMatchObject({
                startLine: 2,
                endLine: 4,
                parentName: 'add',
            });
            expect(getFunction('app/src/main.js', '<anonymous>')).toMatchObject({
                startLine: 5,
                endLine: 7,
            });
        });

        test('Should give arrow functions with an expression body their line range.', () => {
            expect(getFunction('app/src/math.js', 'triple')).toMatchObject({
                startLine: 9,
                endLine: 10,
            });
        });

        test('Should resolve symlinked workspace packages to their repository path.', () => {
            expect(getFunction('packages/lib/index.js', 'libGreet')).toMatchObject({
                startLine: 1,
                endLine: 3,
            });
        });

        test('Should resolve Yarn PnP virtual paths to their repository path.', () => {
            expect(getFunction('packages/peer/index.js', 'peerHello')).toMatchObject({
                startLine: 1,
                endLine: 3,
            });

            const sourceFiles = getFunctions().map((tableFunction) => tableFunction.sourceFile);
            const virtualSourceFiles = sourceFiles.filter((sourceFile) =>
                sourceFile.includes('__virtual__'),
            );
            expect(virtualSourceFiles).toEqual([]);
        });

        test('Should not write the symbol table to the output directory.', () => {
            const contents = outputContents[bundlerName] ?? [];
            expect(contents.length).toBeGreaterThan(0);

            const tableContents = contents.filter((content) => content.includes('"scope_type"'));
            expect(tableContents).toEqual([]);
        });

        if (XPACK_BUNDLERS.includes(bundlerName)) {
            test('Should strip the query string of module IDs.', () => {
                expect(getFunction('app/src/component.js', 'render')).toMatchObject({
                    startLine: 1,
                    endLine: 3,
                });
            });
        }
    });

    describe('webpack | warm filesystem cache', () => {
        if (!BUNDLERS.some(({ name }) => name === 'webpack')) {
            test.skip('webpack is not part of this run.', () => {});
            return;
        }

        let coldTable: SymbolTablePayload | undefined;
        let warmTable: SymbolTablePayload | undefined;
        let cacheDirectory: string;

        beforeAll(async () => {
            cacheDirectory = path.resolve(workingDir, 'webpack-cache');
            const outDir = getOutDir(appDir, 'webpack-cache');

            const build = async () => {
                const plugin = datadogWebpackPlugin({
                    ...defaultPluginOptions,
                    ...PLUGIN_OVERRIDES,
                });
                const config = configWebpack({
                    workingDir: appDir,
                    outDir,
                    entry: { main: './src/main-xpack.js' },
                    plugins: [sourceMapLoaderPlugin, plugin],
                });
                config.cache = { type: 'filesystem', cacheDirectory };
                const { errors } = await buildWithWebpack(config);
                return errors;
            };

            const coldDumpPath = path.resolve(workingDir, 'symbol-table.webpack-cold.json');
            coldTable = await buildWithSymbolTable(coldDumpPath, build);
            const warmDumpPath = path.resolve(workingDir, 'symbol-table.webpack-warm.json');
            warmTable = await buildWithSymbolTable(warmDumpPath, build);
        }, 200000);

        test('Should list the same functions when modules come from the cache.', () => {
            expect(existsSync(cacheDirectory)).toBe(true);
            expect(flattenScopes(coldTable?.scopes).length).toBeGreaterThan(0);
            expect(warmTable).toEqual(coldTable);
        });
    });
    // Minifiers rewrite the injected code and don't map every token, like web-ui's production builds.
    describe('rspack | minified production build', () => {
        if (!BUNDLERS.some(({ name }) => name === 'rspack')) {
            test.skip('rspack is not part of this run.', () => {});
            return;
        }

        let minifiedTable: SymbolTablePayload | undefined;

        beforeAll(async () => {
            const outDir = getOutDir(appDir, 'rspack-production');
            const dumpPath = path.resolve(workingDir, 'symbol-table.rspack-production.json');

            minifiedTable = await buildWithSymbolTable(dumpPath, async () => {
                const plugin = datadogRspackPlugin({
                    ...defaultPluginOptions,
                    ...PLUGIN_OVERRIDES,
                    rum: { privacy: {} },
                });
                const config = configRspack({
                    workingDir: appDir,
                    outDir,
                    entry: { main: './src/main-xpack.js' },
                    plugins: [sourceMapLoaderPlugin, plugin],
                });
                const { errors } = await buildWithRspack({
                    ...config,
                    mode: 'production',
                    optimization: { ...config.optimization, minimize: true },
                });
                return errors;
            });
        }, 200000);

        test('Should give every function its original line range.', () => {
            const functions = flattenScopes(minifiedTable?.scopes);
            const withoutLines = functions.filter((tableFunction) => !tableFunction.endLine);

            expect(functions.length).toBeGreaterThan(0);
            expect(withoutLines).toEqual([]);
            expect(functions).toContainEqual(
                expect.objectContaining({
                    sourceFile: 'app/src/math.js',
                    name: 'add',
                    startLine: 1,
                    endLine: 6,
                }),
            );

            // The end of an expression body is the last token the minifier keeps mapped.
            const triple = functions.find((tableFunction) => tableFunction.name === 'triple');
            expect(triple?.startLine).toBe(9);
            expect(triple?.endLine).toBeGreaterThanOrEqual(9);
            expect(triple?.endLine).toBeLessThanOrEqual(10);
        });
    });
    describe('upload', () => {
        type UploadRequest = { path: string; apiKey: string | string[] | undefined };
        const uploads: Partial<Record<BundlerName, UploadRequest[]>> = {};
        const buildErrors: string[] = [];
        let uploadDir: string;
        let repository: { commitSha: string; remoteUrl: string };

        beforeAll(async () => {
            const seed = `${Math.abs(jest.getSeed())}.symbol-table-upload`;
            uploadDir = getTempWorkingDir(seed);
            await createFixture(uploadDir);
            repository = initGitRepository(uploadDir);
            const buildRoot = path.resolve(uploadDir, APP_DIR);

            let requests: UploadRequest[] = [];
            nock('https://debugger-intake.datadoghq.com')
                .persist()
                .post('/api/v2/debugger')
                .query(true)
                .reply(function recordUpload() {
                    requests.push({ path: this.req.path, apiKey: this.req.headers['dd-api-key'] });
                    return [202, '{}'];
                });

            // Run the builds sequentially to ease the resources usage.
            for (const { name: bundlerName, run } of BUNDLERS) {
                const isXpack = XPACK_BUNDLERS.includes(bundlerName);
                const entry = { main: isXpack ? './src/main-xpack.js' : './src/main.js' };
                const plugins = isXpack ? [sourceMapLoaderPlugin] : [];
                const config = getBundlerConfig(
                    bundlerName,
                    buildRoot,
                    {
                        ...PLUGIN_OVERRIDES,
                        enableGit: true,
                        metadata: { version: '1.0.0', service: 'fixture-service' },
                    },
                    { entry, plugins },
                );
                // eslint-disable-next-line no-await-in-loop
                const { errors } = await run(buildRoot, config);
                buildErrors.push(...errors);
                uploads[bundlerName] = requests;
                requests = [];
            }
        }, 200000);

        afterAll(async () => {
            nock.cleanAll();
            if (!process.env.NO_CLEANUP) {
                await rm(uploadDir);
            }
        });

        test('Should build without errors.', () => {
            expect(buildErrors).toEqual([]);
        });

        test.each(BUNDLERS)('Should upload the table once with $name.', ({ name: bundlerName }) => {
            const requests = uploads[bundlerName] ?? [];
            const [request] = requests;

            expect(requests).toHaveLength(1);
            expect(request.apiKey).toBe(defaultPluginOptions.auth.apiKey);

            const url = new URL(request.path, 'https://debugger-intake.datadoghq.com');
            expect(url.searchParams.get('ddtags')).toBe(
                `git.repository_url:${repository.remoteUrl},git.commit.sha:${repository.commitSha}`,
            );
        });
    });
});
