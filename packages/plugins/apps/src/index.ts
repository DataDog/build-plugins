// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
import { rm } from '@dd/core/helpers/fs';
import type { GetPlugins } from '@dd/core/types';
import chalk from 'chalk';
import type { Program } from 'estree';
import path from 'path';

import { createArchive } from './archive';
import type { Asset } from './assets';
import { collectAssets } from './assets';
import type { BackendFunction } from './backend/discovery';
import {
    discoverBackendFiles,
    encodeQueryName,
    extractExportedFunctions,
} from './backend/discovery';
import { CONFIG_KEY, PLUGIN_NAME } from './constants';
import { resolveIdentifier } from './identifier';
import type { AppsOptions } from './types';
import { uploadArchive } from './upload';
import { validateOptions } from './validate';
import { getVitePlugin } from './vite/index';
import { generateProxyModule } from './vite/proxy-codegen';

export { CONFIG_KEY, PLUGIN_NAME };

/**
 * Type guard: this.parse() returns AstNode (estree.Node) but produces
 * a Program node at the top level.
 */
function isProgramNode(node: { type: string }): node is Program {
    return node.type === 'Program';
}

const yellow = chalk.yellow.bold;
const red = chalk.red.bold;

const BACKEND_FILE_RE = /\.backend\.(ts|tsx|js|jsx)$/;

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

    // Discover backend files (sync — must run before build starts).
    // Only globs for file paths; exports are discovered lazily during transform.
    const backendFiles = discoverBackendFiles(context.buildRoot, log);
    const backendOutputs = new Map<string, string>();
    const hasBackend = backendFiles.length > 0;

    // Mutable array populated during transforms as .backend.ts files are processed.
    const backendFunctions: BackendFunction[] = [];

    const handleUpload = async () => {
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

            // Exclude backend output files from frontend assets if backend is active.
            const backendPaths = new Set(backendOutputs.values());
            const frontendOnly = hasBackend
                ? assets.filter((a) => !backendPaths.has(a.absolutePath))
                : assets;

            // Prefix all frontend assets with frontend/.
            const allAssets: Asset[] = frontendOnly.map((asset) => ({
                ...asset,
                relativePath: `frontend/${asset.relativePath}`,
            }));

            if (hasBackend) {
                // Build backend assets from the outputs map populated during the build.
                // Keys are encoded query names ({hash(path)}.{name}).
                for (const [bundleName, absolutePath] of backendOutputs) {
                    allAssets.push({
                        absolutePath,
                        relativePath: `backend/${bundleName}.js`,
                    });
                }
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
                handler(code, id) {
                    const ast = this.parse(code);
                    let exportNames: string[];
                    try {
                        if (!isProgramNode(ast)) {
                            return undefined;
                        }
                        exportNames = extractExportedFunctions(ast, id);
                    } catch (error) {
                        log.error(
                            `Failed to parse exports from ${id}: ${error instanceof Error ? error.message : String(error)}`,
                        );
                        return undefined;
                    }

                    if (exportNames.length === 0) {
                        log.debug(`No exported functions found in ${id}`);
                        return undefined;
                    }

                    const relativePath = path.relative(context.buildRoot, id);
                    const refPath = relativePath.replace(/\.backend\.\w+$/, '');

                    const proxyExports: Array<{ exportName: string; queryName: string }> = [];
                    for (const exportName of exportNames) {
                        const ref = { path: refPath, name: exportName };
                        backendFunctions.push({ ref, entryPath: id });
                        proxyExports.push({
                            exportName,
                            queryName: encodeQueryName(ref),
                        });
                    }

                    const proxyCode = generateProxyModule(proxyExports);
                    log.debug(`Generated proxy for ${id} with ${proxyExports.length} export(s)`);

                    return { code: proxyCode, map: null };
                },
            },
            vite: getVitePlugin({
                viteBuild: bundler.build,
                buildRoot: context.buildRoot,
                functions: backendFunctions,
                backendOutputs,
                handleUpload,
                log,
                auth: context.auth,
                hasBackend,
            }),
        },
    ];
};
