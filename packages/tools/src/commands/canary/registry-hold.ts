// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { doRequest } from '@dd/core/helpers/request';

import { isJsonObject } from './files';

// Datadog's npm mirror holds back new versions of third-party packages for 2 days
// after they're published. It also caches version lists for up to a day, so a new
// version can stay out of them for about 3 days.
export const REGISTRY_HOLD_MS = 3 * 24 * 60 * 60 * 1_000;

// The mirror leaves held versions out of its own metadata, publish dates included.
const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org';
const PUBLISHED_AT_RETRIES = 2;

export type PackageVersion = {
    name: string;
    version: string;
};

export type HeldPackage = PackageVersion & {
    publishedAt: string;
};

// Returns when a package version was published to npm, or undefined when npm doesn't know it.
export type GetPublishedAt = (packageVersion: PackageVersion) => Promise<string | undefined>;

const NAME = String.raw`(?:@[a-z0-9][\w.-]*/)?[a-z0-9][\w.-]*`;
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?`;
// Tarball URLs may encode the scope's slash.
const URL_NAME = String.raw`(?:@[a-z0-9][\w.-]*(?:/|%2f))?[a-z0-9][\w.-]*`;

// How each package manager reports a version the mirror left out of its version list.
const MISSING_VERSION_PATTERNS = [
    // Yarn 2 and later: `glob@npm:14.0.6: No candidates found`.
    new RegExp(`(${NAME})@npm:(${VERSION}): No candidates found`, 'gi'),
    // Yarn 1: `Couldn't find any versions for "glob" that matches "14.0.6"`.
    new RegExp(`Couldn't find any versions for "(${NAME})" that matches "(${VERSION})"`, 'gi'),
    // npm: `No matching version found for glob@14.0.6.`
    new RegExp(`No matching version found for (${NAME})@(${VERSION})`, 'gi'),
];

// The tarball of a version the mirror refused to serve, for example
// `.../glob/-/glob-14.0.6.tgz`.
const TARBALL_PATTERN = new RegExp(`/(${URL_NAME})/-/[^/\\s"]+?-(${VERSION})\\.tgz`, 'gi');
const FORBIDDEN_STATUS = '403';
// Yarn 2 and later print the status two lines above the URL. Yarn 1 and npm print
// both on one line.
const FORBIDDEN_STATUS_LINES_BEFORE_URL = 3;

const toPackageVersion = (name: string, version: string): PackageVersion => {
    const decodedName = name.replace(/%2f/i, '/');
    // npm ends its message with a period.
    const trimmedVersion = version.replace(/\.+$/, '');
    return { name: decodedName, version: trimmedVersion };
};

const isNearForbiddenStatus = (lines: string[], index: number): boolean => {
    const firstIndex = Math.max(0, index - FORBIDDEN_STATUS_LINES_BEFORE_URL);
    const nearbyLines = lines.slice(firstIndex, index + 1);
    return nearbyLines.some((line) => line.includes(FORBIDDEN_STATUS));
};

// Finds the package versions a failed command's output says the npm registry
// didn't list or refused to serve.
export const findRefusedPackages = (output: string): PackageVersion[] => {
    const refused = new Map<string, PackageVersion>();
    const add = (name: string, version: string): void => {
        const packageVersion = toPackageVersion(name, version);
        refused.set(`${packageVersion.name}@${packageVersion.version}`, packageVersion);
    };

    for (const pattern of MISSING_VERSION_PATTERNS) {
        for (const match of output.matchAll(pattern)) {
            add(match[1], match[2]);
        }
    }

    const lines = output.split('\n');
    for (const [index, line] of lines.entries()) {
        if (!isNearForbiddenStatus(lines, index)) {
            continue;
        }
        for (const match of line.matchAll(TARBALL_PATTERN)) {
            add(match[1], match[2]);
        }
    }

    const packageVersions = refused.values();
    return Array.from(packageVersions);
};

// Returns the refused package versions when the mirror's hold on new versions
// explains them all: npm published each of them less than REGISTRY_HOLD_MS ago.
// Returns undefined when the output names no refused version, or when any of
// them is older or unknown, since something else made the command fail.
export const findRegistryHold = async ({
    getPublishedAt,
    now,
    output,
}: {
    getPublishedAt: GetPublishedAt;
    now: number;
    output: string;
}): Promise<HeldPackage[] | undefined> => {
    const refused = findRefusedPackages(output);
    if (refused.length === 0) {
        return undefined;
    }

    const held: HeldPackage[] = [];
    for (const packageVersion of refused) {
        const publishedAt = await getPublishedAt(packageVersion);
        if (!publishedAt) {
            return undefined;
        }
        const publishedTime = Date.parse(publishedAt);
        const ageMs = now - publishedTime;
        // A date that doesn't parse makes ageMs NaN, which fails both checks.
        if (!(ageMs >= 0 && ageMs < REGISTRY_HOLD_MS)) {
            return undefined;
        }
        held.push({ ...packageVersion, publishedAt });
    }
    return held;
};

export const fetchNpmPublishedAt: GetPublishedAt = async ({ name, version }) => {
    const encodedName = name.replace('/', '%2f');
    const packument = await doRequest<unknown>({
        url: `${PUBLIC_NPM_REGISTRY}/${encodedName}`,
        type: 'json',
        retries: PUBLISHED_AT_RETRIES,
    });
    const times = isJsonObject(packument) ? packument.time : undefined;
    const publishedAt = isJsonObject(times) ? times[version] : undefined;
    return typeof publishedAt === 'string' ? publishedAt : undefined;
};

export const formatHeldPackages = (held: HeldPackage[]): string => {
    return held
        .map(({ name, version, publishedAt }) => `${name}@${version} (published ${publishedAt})`)
        .join(', ');
};
