// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import type { GetPlugins } from '@dd/core/types';
import { InjectPosition } from '@dd/core/types';
import chalk from 'chalk';
import path from 'path';

import { createArchive } from './archive';
import type { Asset } from './assets';
import { collectAssets } from './assets';
import type { BackendFunction } from './backend/discovery';
import { extractExportedFunctions } from './backend/discovery';
import { encodeQueryName } from './backend/encodeQueryName';
import { BACKEND_FILE_RE, CONFIG_KEY, PLUGIN_NAME } from './constants';
import { resolveIdentifier } from './identifier';
import type { AppsOptions } from './types';
import { uploadArchive } from './upload';
import { validateOptions } from './validate';
import { getVitePlugin } from './vite/index';
import { generateProxyModule } from './vite/proxy-codegen';

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

    const handleUpload = async (backendOutputs: Map<string, string>) => {
        const handleTimer = log.time('handle assets');
        let archiveDir: string | undefined;
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

        // Clean temporary directory
        if (archiveDir) {
            await rm(archiveDir);
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
                handleUpload,
                log,
                auth: context.auth,
            }),
        },
    ];
};
