// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import semver from 'semver';

export const MIN_VITE_VERSION = '6.4.0';

const MIN_VITE_LINE = `${semver.major(MIN_VITE_VERSION)}.${semver.minor(MIN_VITE_VERSION)}`;

export const unsupportedViteMessage = (version: string, importedVersion = version) => {
    const found =
        importedVersion === version ? version : `${version} running, ${importedVersion} imported`;
    return `The Datadog Apps plugin needs Vite ${MIN_VITE_LINE} or later (found ${found}).`;
};

const readProperty = (value: unknown, key: string): unknown =>
    typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;

const isSupportedVersion = (version: string): boolean => {
    const parsed = semver.parse(version);
    return parsed !== null && !semver.lt(parsed, MIN_VITE_VERSION);
};

// Vite 7 and later give every hook `this.meta.viteVersion`; Vite 6 doesn't. Both versions must
// pass, since the plugin calls the imported `vite` module, which can come from another install.
export function assertSupportedVite(hookContext: unknown, importedVersion: string): void {
    const meta = readProperty(hookContext, 'meta');
    const runningVersion = readProperty(meta, 'viteVersion');
    const version = typeof runningVersion === 'string' ? runningVersion : importedVersion;
    if (!isSupportedVersion(version) || !isSupportedVersion(importedVersion)) {
        const message = unsupportedViteMessage(version, importedVersion);
        throw new Error(message);
    }
}
