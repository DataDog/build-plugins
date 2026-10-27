// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, readFile } from '@dd/core/helpers/fs';
import { doRequest } from '@dd/core/helpers/request';
import path from 'path';

import type { JsonObject } from './files';
import { isJsonObject, readJsonObject } from './files';
import { CanaryCommandError } from './runner';
import type { CanaryTarget } from './types';

export const DEFAULT_NODE_DIST_URL = 'https://nodejs.org/dist';

// Checked in order; the first one that exists wins.
const NODE_VERSION_FILES = ['.nvmrc', '.node-version'];
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const PARTIAL_VERSION = /^\d+(?:\.\d+)?$/;
const LTS_ALIAS = /^lts\/(.+)$/i;
const LATEST_ALIASES = ['current', 'latest', 'node', 'stable'];
const PACKAGE_MANAGER = /^(npm|pnpm|yarn)@(\d+)\.\d+\.\d+(?:-[\w.]+)?(?:\+.+)?$/;
// Corepack doesn't support Yarn 6 and later, which ship through Yarn Switch instead.
const FIRST_YARN_SWITCH_MAJOR = 6;

export type NodeRelease = {
    version: string;
    // The LTS codename, or false for releases that aren't LTS.
    lts: string | false;
};

export type NodeVersionSpec = {
    spec: string;
    source: string;
};

export type PackageManager = {
    name: string;
    version: string;
    installer: 'corepack' | 'yarn-switch';
};

export type Toolchain = {
    node: {
        version: string;
        source: string;
    };
    packageManager: PackageManager;
};

// .nvmrc files can hold comments and trailing whitespace, and versions may start with "v".
const normalizeVersionSpec = (content: string): string => {
    const lines = content.split('\n');
    const line = lines.find((entry) => entry.replace(/#.*/, '').trim().length > 0) ?? '';
    const spec = line.replace(/#.*/, '').trim();
    return spec.replace(/^v(?=\d)/, '');
};

export const readNodeVersionSpec = async (
    root: string,
    fallback: string | undefined,
): Promise<NodeVersionSpec> => {
    for (const fileName of NODE_VERSION_FILES) {
        const filePath = path.resolve(root, fileName);
        if (!existsSync(filePath)) {
            continue;
        }
        const content = await readFile(filePath);
        const spec = normalizeVersionSpec(content);
        if (spec) {
            return { spec, source: fileName };
        }
    }

    const packageJsonPath = path.resolve(root, 'package.json');
    const packageJson = await readJsonObject(packageJsonPath);
    const volta = packageJson.volta;
    if (isJsonObject(volta) && typeof volta.node === 'string') {
        const spec = normalizeVersionSpec(volta.node);
        return { spec, source: 'package.json volta.node' };
    }

    if (fallback) {
        const spec = normalizeVersionSpec(fallback);
        return { spec, source: 'target definition' };
    }

    throw new CanaryCommandError(
        `${root} pins no Node.js version (.nvmrc, .node-version or volta.node) and the target defines no fallback.`,
    );
};

export const parseNodeReleases = (value: unknown): NodeRelease[] => {
    if (!Array.isArray(value)) {
        throw new CanaryCommandError('The Node.js release index is not a list.');
    }

    return value.map((entry): NodeRelease => {
        const version = isJsonObject(entry) ? entry.version : undefined;
        const lts = isJsonObject(entry) ? entry.lts : undefined;
        if (typeof version !== 'string' || (typeof lts !== 'string' && lts !== false)) {
            throw new CanaryCommandError('The Node.js release index has an unexpected entry.');
        }
        return { version, lts };
    });
};

export const fetchNodeReleases = async (distUrl: string): Promise<NodeRelease[]> => {
    const index = await doRequest<unknown>({ url: `${distUrl}/index.json`, type: 'json' });
    return parseNodeReleases(index);
};

const getVersionParts = (release: NodeRelease): number[] => {
    return release.version.replace(/^v/, '').split('.').map(Number);
};

const compareReleasesNewestFirst = (first: NodeRelease, second: NodeRelease): number => {
    const firstParts = getVersionParts(first);
    const secondParts = getVersionParts(second);
    for (const [index, firstPart] of firstParts.entries()) {
        const difference = (secondParts[index] ?? 0) - firstPart;
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
};

const getReleaseMatcher = (spec: string): ((release: NodeRelease) => boolean) => {
    if (PARTIAL_VERSION.test(spec)) {
        return (release) => release.version.startsWith(`v${spec}.`);
    }
    if (spec === 'lts/*') {
        return (release) => release.lts !== false;
    }
    const ltsMatch = LTS_ALIAS.exec(spec);
    if (ltsMatch) {
        const codename = ltsMatch[1]?.toLowerCase();
        return (release) => release.lts !== false && release.lts.toLowerCase() === codename;
    }
    if (LATEST_ALIASES.includes(spec)) {
        return () => true;
    }
    throw new CanaryCommandError(`Unsupported Node.js version "${spec}".`);
};

// Resolves partial versions and nvm aliases to the newest matching release.
export const resolveNodeVersion = async (
    spec: string,
    getReleases: () => Promise<NodeRelease[]>,
): Promise<string> => {
    if (EXACT_VERSION.test(spec)) {
        return spec;
    }

    const matches = getReleaseMatcher(spec);
    const releases = await getReleases();
    const newestFirst = [...releases].sort(compareReleasesNewestFirst);
    const release = newestFirst.find(matches);
    if (!release) {
        throw new CanaryCommandError(`No Node.js release matches "${spec}".`);
    }
    return release.version.replace(/^v/, '');
};

export const parsePackageManager = (packageJson: JsonObject): PackageManager => {
    const field = packageJson.packageManager;
    if (typeof field !== 'string') {
        throw new CanaryCommandError('The target checkout declares no packageManager.');
    }

    const match = PACKAGE_MANAGER.exec(field);
    const name = match?.[1];
    const major = match?.[2];
    if (!name || !major) {
        throw new CanaryCommandError(`Unsupported packageManager "${field}".`);
    }

    // Drop the "+sha..." integrity suffix; installers take the bare version.
    const version = field.slice(name.length + 1).replace(/\+.*$/, '');
    const usesYarnSwitch = name === 'yarn' && Number(major) >= FIRST_YARN_SWITCH_MAJOR;
    return {
        name,
        version,
        installer: usesYarnSwitch ? 'yarn-switch' : 'corepack',
    };
};

export const resolveToolchain = async ({
    getNodeReleases,
    root,
    target,
}: {
    getNodeReleases: () => Promise<NodeRelease[]>;
    root: string;
    target: CanaryTarget;
}): Promise<Toolchain> => {
    const nodeSpec = await readNodeVersionSpec(root, target.nodeVersion);
    const nodeVersion = await resolveNodeVersion(nodeSpec.spec, getNodeReleases);
    const packageJsonPath = path.resolve(root, 'package.json');
    const packageJson = await readJsonObject(packageJsonPath);
    const packageManager = parsePackageManager(packageJson);

    return {
        node: {
            version: nodeVersion,
            source: nodeSpec.source,
        },
        packageManager,
    };
};

// Shell- and GitLab-dotenv-compatible KEY=value lines for the CI job script.
export const formatToolchainEnvironment = (toolchain: Toolchain, commit: string): string => {
    const variables = {
        CANARY_TARGET_COMMIT: commit,
        CANARY_NODE_VERSION: toolchain.node.version,
        CANARY_PACKAGE_MANAGER: toolchain.packageManager.name,
        CANARY_PACKAGE_MANAGER_VERSION: toolchain.packageManager.version,
        CANARY_PACKAGE_MANAGER_INSTALLER: toolchain.packageManager.installer,
    };
    const lines = Object.entries(variables).map(([key, value]) => `${key}=${value}`);
    return `${lines.join('\n')}\n`;
};
