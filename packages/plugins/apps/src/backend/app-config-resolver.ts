// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, readFileSync } from '@dd/core/helpers/fs';
import path from 'path';

export const APP_CONFIG_FILENAME = 'datadog-app.config.json';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves custom credential connection IDs directly from datadog-app.config.json in projectRoot.
 * Returns an empty array if the file is absent, malformed, or contains no valid UUIDs.
 */
export function resolveAppConfigCredentialIds(projectRoot: string): string[] {
    const filePath = path.join(projectRoot, APP_CONFIG_FILENAME);
    if (!existsSync(filePath)) {
        return [];
    }

    let raw: string;
    try {
        raw = readFileSync(filePath);
    } catch {
        return [];
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed) ||
        !('customCredentialIds' in parsed)
    ) {
        return [];
    }

    const { customCredentialIds } = parsed;
    if (!Array.isArray(customCredentialIds)) {
        return [];
    }

    return customCredentialIds
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter((id) => UUID_PATTERN.test(id));
}
