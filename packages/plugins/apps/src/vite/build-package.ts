// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDDEnvValue } from '@dd/core/helpers/env';
import { rm } from '@dd/core/helpers/fs';
import type { GlobalContext } from '@dd/core/types';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

import { createArchive } from '../archive';
import type { Asset } from '../assets';
import { collectAssets } from '../assets';
import { encodeQueryName } from '../backend/encodeQueryName';
import type { BackendFunction } from '../backend/types';
import { ARCHIVE_FILENAME, PLUGIN_NAME } from '../constants';
import type { AppsManifest, AppsOptionsWithDefaults } from '../types';

export interface BuildAppPackageOptions {
    backendOutputs: Map<string, string>;
    backendFunctions: BackendFunction[];
    context: GlobalContext;
    options: AppsOptionsWithDefaults;
}

function buildManifest(backendFunctions: BackendFunction[]): AppsManifest {
    const functions: AppsManifest['backend']['functions'] = {};
    for (const func of backendFunctions) {
        functions[encodeQueryName(func)] = {
            allowedConnectionIds: [...func.allowedConnectionIds],
        };
    }

    return { backend: { functions } };
}

async function writeManifestFile(
    backendFunctions: BackendFunction[],
): Promise<{ manifestAsset: Asset; cleanup: () => Promise<void> }> {
    const manifestDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dd-apps-manifest-'));
    const manifestPath = path.join(manifestDir, 'manifest.json');
    try {
        await fsp.writeFile(manifestPath, JSON.stringify(buildManifest(backendFunctions), null, 2));
    } catch (error) {
        await rm(manifestDir);
        throw error;
    }
    return {
        manifestAsset: { absolutePath: manifestPath, relativePath: 'manifest.json' },
        cleanup: () => rm(manifestDir),
    };
}

export async function buildAppPackage({
    backendOutputs,
    backendFunctions,
    context,
    options,
}: BuildAppPackageOptions): Promise<string | undefined> {
    const log = context.getLogger(PLUGIN_NAME);
    const {
        buildRoot,
        bundler: { outDir },
    } = context;
    const defaultArchivePath = path.join(outDir, ARCHIVE_FILENAME);
    const packageDirectory = path.resolve(getDDEnvValue('APPS_PACKAGE_DIR') || outDir);
    const archivePath = path.join(packageDirectory, ARCHIVE_FILENAME);

    // Remove stale package outputs before collecting assets so that previous
    // archive files don't alter the common-prefix computation used to strip
    // the output directory from asset paths.
    await Promise.all([
        fsp.rm(archivePath, { force: true }),
        fsp.rm(defaultArchivePath, { force: true }),
    ]);

    const relativeOutdir = path.relative(buildRoot, outDir);
    const assets = await collectAssets([...options.include, `${relativeOutdir}/**/*`], buildRoot);
    if (assets.length === 0 && backendOutputs.size === 0) {
        log.debug('No assets to package.');
        return undefined;
    }

    await fsp.mkdir(packageDirectory, { recursive: true });

    let cleanupManifest: (() => Promise<void>) | undefined;
    try {
        const generatedPaths = new Set([archivePath, defaultArchivePath]);
        const backendPaths = new Set(backendOutputs.values());
        const frontendAssets = assets
            .filter((asset) => !generatedPaths.has(path.resolve(asset.absolutePath)))
            .filter((asset) => !backendPaths.has(asset.absolutePath))
            .map((asset) => ({
                ...asset,
                relativePath: `frontend/${asset.relativePath}`,
            }));
        const packageAssets: Asset[] = [...frontendAssets];
        for (const [bundleName, absolutePath] of backendOutputs) {
            packageAssets.push({
                absolutePath,
                relativePath: `backend/${bundleName}.js`,
            });
        }
        const manifest = await writeManifestFile(backendFunctions);
        cleanupManifest = manifest.cleanup;
        packageAssets.push(manifest.manifestAsset);
        const archive = await createArchive(packageAssets, archivePath);
        log.info(`App package written to ${archive.archivePath}.`);
        return archive.archivePath;
    } finally {
        await cleanupManifest?.();
    }
}
