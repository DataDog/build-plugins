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
import { resolveIdentifier } from '../identifier';
import type { AppsManifest, AppsOptionsWithDefaults } from '../types';

export const BUILD_ARTIFACT_FILENAME = 'datadog-apps-build.json';
export const BUILD_ARTIFACT_SCHEMA_VERSION = 1;

export interface BuildArtifact {
    schemaVersion: typeof BUILD_ARTIFACT_SCHEMA_VERSION;
    bundle: typeof ARCHIVE_FILENAME;
    identifier: string;
    name: string;
}

export interface BuildAppPackageOptions {
    backendOutputs: Map<string, string>;
    backendFunctions: BackendFunction[];
    context: GlobalContext;
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
    if (options.description != null) {
        manifest.description = options.description;
    }
    if (options.selfService != null) {
        manifest.selfService = options.selfService;
    }
    const protectionLevel = options.permissions?.protectionLevel ?? null;
    const runAs = options.permissions?.runAs ?? null;
    if (protectionLevel != null || runAs != null) {
        manifest.permissions = {
            ...(protectionLevel != null && { protectionLevel }),
            ...(runAs != null && { runAs }),
        };
    }
    return manifest;
}

async function writeManifestFile(
    backendFunctions: BackendFunction[],
    options: AppsOptionsWithDefaults,
): Promise<{ manifestAsset: Asset; cleanup: () => Promise<void> }> {
    const manifestDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dd-apps-manifest-'));
    const manifestPath = path.join(manifestDir, 'manifest.json');
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
        manifestAsset: { absolutePath: manifestPath, relativePath: 'manifest.json' },
        cleanup: () => rm(manifestDir),
    };
}

async function writeBuildArtifact(
    packageDirectory: string,
    artifact: BuildArtifact,
): Promise<void> {
    const destination = path.join(packageDirectory, BUILD_ARTIFACT_FILENAME);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    try {
        await fsp.writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`);
        await fsp.rename(temporary, destination);
    } catch (error) {
        await fsp.rm(temporary, { force: true });
        throw error;
    }
}

export async function buildAppPackage({
    backendOutputs,
    backendFunctions,
    context,
    options,
}: BuildAppPackageOptions): Promise<BuildArtifact | undefined> {
    const log = context.getLogger(PLUGIN_NAME);
    const {
        buildRoot,
        bundler: { outDir },
        git,
    } = context;
    const defaultArchivePath = path.join(outDir, ARCHIVE_FILENAME);
    const defaultDescriptorPath = path.join(outDir, BUILD_ARTIFACT_FILENAME);
    const packageDirectory = path.resolve(getDDEnvValue('APPS_PACKAGE_DIR') || outDir);
    const archivePath = path.join(packageDirectory, ARCHIVE_FILENAME);
    const descriptorPath = path.join(packageDirectory, BUILD_ARTIFACT_FILENAME);
    const { name, identifier } = resolveIdentifier(buildRoot, log, {
        url: git?.remote,
        name: options.name,
        identifier: options.identifier,
    });
    if (!identifier || !name) {
        throw new Error(
            `Missing apps identification.\nEither:\n  - pass an 'options.apps.identifier' and 'options.apps.name' to your plugin's configuration.\n  - have a 'name' and a 'repository' in your 'package.json'.\n  - have a valid remote url on your git project.\n`,
        );
    }

    // Remove stale package outputs before collecting assets so that previous
    // archive/descriptor files don't alter the common-prefix computation used
    await Promise.all([
        fsp.rm(archivePath, { force: true }),
        fsp.rm(descriptorPath, { force: true }),
        fsp.rm(defaultArchivePath, { force: true }),
        fsp.rm(defaultDescriptorPath, { force: true }),
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
        const generatedPaths = new Set([
            archivePath,
            descriptorPath,
            defaultArchivePath,
            defaultDescriptorPath,
        ]);
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
        const manifest = await writeManifestFile(backendFunctions, options);
        cleanupManifest = manifest.cleanup;
        packageAssets.push(manifest.manifestAsset);
        const archive = await createArchive(packageAssets, archivePath);
        const artifact: BuildArtifact = {
            schemaVersion: BUILD_ARTIFACT_SCHEMA_VERSION,
            bundle: ARCHIVE_FILENAME,
            identifier,
            name,
        };
        await writeBuildArtifact(packageDirectory, artifact);
        log.info(`App package written to ${archive.archivePath}.`);
        return artifact;
    } finally {
        await cleanupManifest?.();
    }
}
