// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import type { GetPlugins } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import chalk from 'chalk';
import type { Program } from 'estree';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

import { createArchive } from './archive';
import type { Asset } from './assets';
import { collectAssets } from './assets';
import type { BackendFunction } from './backend/discovery';
import { extractExportedFunctions } from './backend/discovery';
import { encodeQueryName } from './backend/encodeQueryName';
import { extractConnectionIds, findConnectionsFile } from './backend/extract-connections';
import { generateProxyModule } from './backend/proxy-codegen';
import { BACKEND_FILE_RE, CONFIG_KEY, PLUGIN_NAME } from './constants';
import { resolveIdentifier } from './identifier';
import type { AppsOptions } from './types';
import { uploadArchive } from './upload';
import { validateOptions } from './validate';
import { getVitePlugin } from './vite/index';

export { CONFIG_KEY, PLUGIN_NAME };

/**
 * Build BackendFunction entries from discovered export names and generate
 * the frontend proxy module that replaces the original backend code.
 */
function buildProxyModule(
    exportNames: string[],
    id: string,
    buildRoot: string,
): { functions: BackendFunction[]; proxyCode: string } {
    const relativePath = path.relative(buildRoot, id);
    const refPath = relativePath.replace(BACKEND_FILE_RE, '');

    const functions: BackendFunction[] = [];
    const proxyExports: Array<{ exportName: string; queryName: string }> = [];

    for (const exportName of exportNames) {
        const func = { relativePath: refPath, name: exportName, absolutePath: id };
        functions.push(func);
        proxyExports.push({ exportName, queryName: encodeQueryName(func) });
    }

    return { functions, proxyCode: generateProxyModule(proxyExports) };
}

const yellow = chalk.yellow.bold;
const red = chalk.red.bold;

/**
 * Create a registry for tracking discovered backend functions.
 * Uses a Map keyed by entryPath so that re-transforms (e.g. during HMR)
 * replace stale entries for a file instead of appending duplicates.
 */
function createBackendFunctionRegistry() {
    const functionsByEntryPath = new Map<string, BackendFunction[]>();

    return {
        /** Replace all entries for a given file. Handles HMR re-transforms. */
        setBackendFunctions(entryPath: string, functions: BackendFunction[]) {
            functionsByEntryPath.set(entryPath, functions);
        },
        /** Get a flat array of all currently registered backend functions. */
        getBackendFunctions(): BackendFunction[] {
            return Array.from(functionsByEntryPath.values()).flat();
        },
    };
}

export interface ConnectionIdsRegistry {
    getConnectionIds(): string[];
    clearConnectionIds(): void;
    loadAndSetConnectionIds(
        load: (filePath: string) => Promise<string | null>,
    ): Promise<{ filePath: string | null; connectionIds: string[] }>;
}

function createConnectionIdsRegistry(opts: {
    getBuildRoot: () => string;
    parse: (code: string) => Program;
}): ConnectionIdsRegistry {
    let connectionIds: string[] = [];
    return {
        getConnectionIds() {
            return connectionIds;
        },
        clearConnectionIds() {
            connectionIds = [];
        },
        async loadAndSetConnectionIds(load) {
            const filePath = await findConnectionsFile(opts.getBuildRoot());
            if (!filePath) {
                connectionIds = [];
                return { filePath: null, connectionIds };
            }
            const code = await load(filePath);
            if (code == null) {
                throw new Error(`connections file '${filePath}' produced no code when loaded`);
            }
            connectionIds = extractConnectionIds(opts.parse(code), filePath, code);
            return { filePath, connectionIds };
        },
    };
}

export type types = {
    // Add the types you'd like to expose here.
    AppsOptions: AppsOptions;
};

export const getPlugins: GetPlugins = ({ options, context, bundler }) => {
    const log = context.getLogger(PLUGIN_NAME);
    let toThrow: Error | undefined;
    const validatedOptions = validateOptions(options);
    if (!validatedOptions.enable) {
        return [];
    }

    if (context.bundler.name !== 'vite') {
        log.warn(`The apps plugin only supports Vite; skipping under '${context.bundler.name}'.`);
        return [];
    }

    // Inject the runtime that `globalThis.DD_APPS_RUNTIME.executeBackendFunction`
    // is read from. The generated proxy modules (emitted by the transform hook
    // below) reference that global. NOTE: This file is built alongside the
    // bundler plugin via the `toBuild` entry in @dd/apps-plugin's package.json.
    //
    // Position MIDDLE is used instead of BEFORE so Vite's dev server injects
    // the runtime as a <script type="module"> via `transformIndexHtml` — BEFORE
    // is served via Rollup's `banner()` output hook which only fires at build
    // time, leaving the runtime undefined during `vite` (dev).
    context.inject({
        type: 'file',
        position: InjectPosition.MIDDLE,
        value: path.join(__dirname, './apps-runtime.mjs'),
    });

    const { setBackendFunctions, getBackendFunctions } = createBackendFunctionRegistry();

    const connectionRegistry = createConnectionIdsRegistry({
        getBuildRoot: () => context.buildRoot,
        parse: (code) => bundler.parseAst(code) as Program,
    });

    const handleUpload = async (backendOutputs: Map<string, string>) => {
        const handleTimer = log.time('handle assets');
        let archiveDir: string | undefined;
        let manifestDir: string | undefined;
        try {
            const identifierTimer = log.time('resolve identifier');

            const { name, identifier } = resolveIdentifier(context.buildRoot, log, {
                url: context.git?.remote,
                name: validatedOptions.name,
                identifier: validatedOptions.identifier,
            });

            if (!identifier || !name) {
                throw new Error(`Missing apps identification.
Either:
  - pass an 'options.apps.identifier' and 'options.apps.name' to your plugin's configuration.
  - have a 'name' and a 'repository' in your 'package.json'.
  - have a valid remote url on your git project.
`);
            }
            identifierTimer.end();

            const relativeOutdir = path.relative(context.buildRoot, context.bundler.outDir);
            const assetGlobs = [...validatedOptions.include, `${relativeOutdir}/**/*`];

            const assets = await collectAssets(assetGlobs, context.buildRoot);

            if (!assets.length) {
                log.debug(`No assets to upload.`);
                return;
            }

            // Exclude backend output files from frontend assets.
            const backendPaths = new Set(backendOutputs.values());
            const frontendOnly = assets.filter((a) => !backendPaths.has(a.absolutePath));

            // Prefix all frontend assets with frontend/.
            // Use POSIX joins — archive entries must use forward slashes.
            const allAssets: Asset[] = frontendOnly.map((asset) => ({
                ...asset,
                relativePath: `frontend/${asset.relativePath}`,
            }));

            // Append backend assets from the outputs map populated during the build.
            // Keys are encoded query names ({hash(path)}.{name}).
            for (const [bundleName, absolutePath] of backendOutputs) {
                allAssets.push({
                    absolutePath,
                    relativePath: `backend/${bundleName}.js`,
                });
            }

            // Emit manifest.json at the zip root with the per-function allowed
            // connection IDs so the server-side actions runtime can allowlist
            // the connections each function uses. The same union list (from
            // connections.ts) is applied to every function — the server
            // supports distinct lists, but the RFC explicitly accepts a flat
            // union as the chosen design.
            if (backendOutputs.size > 0) {
                const allowedConnectionIds = connectionRegistry.getConnectionIds();
                const functions: Record<string, { allowedConnectionIds: string[] }> = {};
                for (const bundleName of backendOutputs.keys()) {
                    functions[bundleName] = { allowedConnectionIds };
                }
                const manifest = { backend: { functions } };
                manifestDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dd-apps-manifest-'));
                const manifestPath = path.join(manifestDir, 'manifest.json');
                await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
                allAssets.push({
                    absolutePath: manifestPath,
                    relativePath: 'manifest.json',
                });
                log.debug(
                    `Emitted manifest.json with ${allowedConnectionIds.length} connection ID(s)`,
                );
            }

            const archiveTimer = log.time('archive assets');
            const archive = await createArchive(allAssets);
            archiveTimer.end();
            // Store variable for later disposal of directory.
            archiveDir = path.dirname(archive.archivePath);

            const uploadTimer = log.time('upload assets');
            const { errors: uploadErrors, warnings: uploadWarnings } = await uploadArchive(
                archive,
                {
                    apiKey: context.auth.apiKey,
                    appKey: context.auth.appKey,
                    bundlerName: context.bundler.name,
                    dryRun: validatedOptions.dryRun,
                    identifier,
                    name,
                    site: context.auth.site,
                    version: context.version,
                },
                log,
            );
            uploadTimer.end();

            if (uploadWarnings.length > 0) {
                log.warn(
                    `${yellow('Warnings while uploading assets:')}\n    - ${uploadWarnings.join('\n    - ')}`,
                );
            }

            if (uploadErrors.length > 0) {
                const listOfErrors = uploadErrors
                    .map((error) => error.cause || error.stack || error.message || error)
                    .join('\n    - ');
                throw new Error(`    - ${listOfErrors}`);
            }
        } catch (error: any) {
            toThrow = error;
            log.error(`${red('Failed to upload assets:')}\n${error?.message || error}`);
        }

        // Clean temporary directories
        if (archiveDir) {
            await rm(archiveDir);
        }
        if (manifestDir) {
            await rm(manifestDir);
        }
        handleTimer.end();

        if (toThrow) {
            // Break the build.
            throw toThrow;
        }
    };

    // All build + upload logic is handled inside the Vite sub-plugin's closeBundle.
    // When backend functions exist, it builds them first, then uploads everything.
    return [
        {
            name: PLUGIN_NAME,
            enforce: 'post',
            transform: {
                filter: {
                    id: {
                        include: [BACKEND_FILE_RE],
                        exclude: [/node_modules/, /[/\\]dist[/\\]/],
                    },
                },
                // For each .backend.* file, parse its named exports, register
                // them as backend functions, and replace the module with a
                // frontend proxy that calls executeBackendFunction at runtime.
                handler(code, id) {
                    const exportNames = extractExportedFunctions(this.parse(code), id);
                    if (exportNames.length === 0) {
                        log.warn(
                            `Backend file ${id} has no exported functions. ` +
                                `Did you forget to add a named export?`,
                        );
                        // Clear any previously registered functions for this file
                        // so stale entries don't persist across HMR re-transforms.
                        setBackendFunctions(id, []);
                        return { code: '', map: null };
                    }

                    const { functions, proxyCode } = buildProxyModule(
                        exportNames,
                        id,
                        context.buildRoot,
                    );
                    setBackendFunctions(id, functions);
                    log.debug(`Generated proxy for ${id} with ${functions.length} export(s)`);

                    return { code: proxyCode, map: null };
                },
            },
            vite: getVitePlugin({
                viteBuild: bundler.build,
                buildRoot: context.buildRoot,
                getBackendFunctions,
                connectionRegistry,
                handleUpload,
                log,
                auth: context.auth,
            }),
        },
    ];
};
