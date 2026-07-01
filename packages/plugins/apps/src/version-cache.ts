// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';
import path from 'path';

type VersionCache = { identifier: string; version_id: string };

const CACHE_FILENAME = '.datadog-app-version.json';

export const getVersionCachePath = (cwd = process.cwd()) => path.join(cwd, CACHE_FILENAME);

export const writeVersionCache = (identifier: string, version_id: string, cwd = process.cwd()) => {
    const cachePath = getVersionCachePath(cwd);
    const data: VersionCache = { identifier, version_id };
    fs.writeFileSync(cachePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

const isVersionCache = (value: unknown): value is VersionCache => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    // 'in' narrowing gives us object & { identifier: unknown } etc., no cast needed.
    return (
        'identifier' in value &&
        'version_id' in value &&
        typeof value.identifier === 'string' &&
        typeof value.version_id === 'string'
    );
};

export const readVersionCache = (cwd = process.cwd()): VersionCache | null => {
    const cachePath = getVersionCachePath(cwd);
    try {
        const raw = fs.readFileSync(cachePath, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        return isVersionCache(parsed) ? parsed : null;
    } catch {
        return null;
    }
};
