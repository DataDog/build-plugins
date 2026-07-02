// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { rm } from '@dd/core/helpers/fs';
import type { GlobalContext } from '@dd/core/types';
import chalk from 'chalk';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

import { createArchive } from '../archive';
import type { Asset } from '../assets';
import { collectAssets } from '../assets';
import type { DoAuthenticatedRequest } from '../auth';
import { encodeQueryName } from '../backend/encodeQueryName';
import type { BackendFunction } from '../backend/types';
import { PLUGIN_NAME } from '../constants';
import { resolveIdentifier } from '../identifier';
import type { AppsManifest, AppsOptionsWithDefaults } from '../types';
import { uploadArchive } from '../upload';

const yellow = chalk.yellow.bold;
const red = chalk.red.bold;
const MANIFEST_FILE_NAME = 'manifest.json';

export interface HandleUploadOptions {
    backendOutputs: Map<string, string>;
    backendFunctions: BackendFunction[];
    context: GlobalContext;
    doAuthenticatedRequest: DoAuthenticatedRequest;
    options: AppsOptionsWithDefaults;
}

function buildManifest(
    backendFunctions: BackendFunction[],
    options: AppsOptionsWithDefaults,
): AppsManifest {
    const functions: AppsManifest['backend']['functions'] = {};
    for (const func of backendFunctions) {
        functions[encodeQueryName(func)] = {
            allowedConnectionIds: [...func.allowedConnectionIds],
        };
    }

    const manifest: AppsManifest = { backend: { functions } };

    // Include optional app properties when specified — the server ignores absent fields
    // and leaves the existing values unchanged, so omitting them is always safe.
    if (options.description !== undefined) {
        manifest.description = options.description;
    }
    if (options.selfService !== undefined) {
        manifest.selfService = options.selfService;
    }
    // Only include permissions if at least one field is set — an empty object {}
    // would be serialised as `"permissions": {}` and may unintentionally override
    // server-side values (the server treats any present key as an explicit update).
    if (
        options.permissions !== undefined &&
        (options.permissions.protectionLevel !== undefined ||
            options.permissions.runAs !== undefined)
    ) {
        manifest.permissions = options.permissions;
    }

    return manifest;
}

async function writeManifestFile(
    backendFunctions: BackendFunction[],
    options: AppsOptionsWithDefaults,
): Promise<{
    manifestAsset: Asset;
    cleanup: () => Promise<void>;
}> {
    const manifestDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dd-apps-manifest-'));
    const manifestPath = path.join(manifestDir, MANIFEST_FILE_NAME);
    try {
        await fsp.writeFile(
            manifestPath,
            JSON.stringify(buildManifest(backendFunctions, options), null, 2),
        );
    } catch (error) {
        await rm(manifestDir);
        throw error;
    }
    return {
        manifestAsset: {
            absolutePath: manifestPath,
            relativePath: MANIFEST_FILE_NAME,
        },
        cleanup: () => rm(manifestDir),
    };
}

export const handleUpload = async ({
    backendOutputs,
    backendFunctions,
    context,
    doAuthenticatedRequest,
    options,
}: HandleUploadOptions) => {
    const log = context.getLogger(PLUGIN_NAME);
    const {
        auth,
        buildRoot,
        bundler: { name: bundlerName, outDir },
        git,
        version,
    } = context;
    const handleTimer = log.time('handle assets');
    let archiveDir: string | undefined;
    let cleanupManifest: (() => Promise<void>) | undefined;
    let toThrow: Error | undefined;
    try {
        const identifierTimer = log.time('resolve identifier');

        const { name, identifier } = resolveIdentifier(buildRoot, log, {
            url: git?.remote,
            name: options.name,
            identifier: options.identifier,
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

        const relativeOutdir = path.relative(buildRoot, outDir);
        const assetGlobs = [...options.include, `${relativeOutdir}/**/*`];

        const assets = await collectAssets(assetGlobs, buildRoot);

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

        const { manifestAsset, cleanup } = await writeManifestFile(backendFunctions, options);
        cleanupManifest = cleanup;
        allAssets.push(manifestAsset);

        const archiveTimer = log.time('archive assets');
        const archive = await createArchive(allAssets);
        archiveTimer.end();
        // Store variable for later disposal of directory.
        archiveDir = path.dirname(archive.archivePath);

        const uploadTimer = log.time('upload assets');
        const { errors: uploadErrors, warnings: uploadWarnings } = await uploadArchive(
            archive,
            {
                bundlerName,
                doAuthenticatedRequest,
                dryRun: options.dryRun,
                identifier,
                name,
                site: auth.site,
                version,
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
    if (cleanupManifest) {
        await cleanupManifest();
    }
    handleTimer.end();

    if (toThrow) {
        // Break the build.
        throw toThrow;
    }
};
