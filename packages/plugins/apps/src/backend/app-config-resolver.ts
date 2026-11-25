// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { existsSync, readFileSync } from '@dd/core/helpers/fs';
import type { Logger } from '@dd/core/types';
import path from 'path';

import { APP_CONFIG_FILE } from '../app-identity';

import { UUID_PATTERN } from './connection-ids';

/**
 * Resolves custom credential connection IDs directly from datadog-app.config.json in projectRoot.
 * Warns and returns an empty array if the file is unreadable or malformed, and warns on skipped entries.
 */
export function resolveAppConfigCredentialIds(projectRoot: string, log: Logger): string[] {
    const filePath = path.join(projectRoot, APP_CONFIG_FILE);
    if (!existsSync(filePath)) {
        return [];
    }

    let raw: string;
    try {
        raw = readFileSync(filePath);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`Could not read ${APP_CONFIG_FILE}: ${message}`);
        return [];
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`Could not parse ${APP_CONFIG_FILE}: ${message}`);
        return [];
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        log.warn(`Ignoring ${APP_CONFIG_FILE}: root value must be a JSON object.`);
        return [];
    }

    if (!('customCredentialIds' in parsed) || parsed.customCredentialIds === undefined) {
        return [];
    }

    const { customCredentialIds } = parsed;
    if (!Array.isArray(customCredentialIds)) {
        log.warn(
            `Ignoring customCredentialIds in ${APP_CONFIG_FILE}: value must be an array of UUIDs.`,
        );
        return [];
    }

    const validIds: string[] = [];
    let invalidCount = 0;
    for (const entry of customCredentialIds) {
        if (typeof entry === 'string') {
            const trimmed = entry.trim();
            if (UUID_PATTERN.test(trimmed)) {
                const normalized = trimmed.toLowerCase();
                validIds.push(normalized);
                continue;
            }
        }
        invalidCount += 1;
    }

    if (invalidCount > 0) {
        const label = invalidCount === 1 ? 'entry' : 'entries';
        log.warn(
            `Ignoring ${invalidCount} invalid customCredentialIds ${label} in ${APP_CONFIG_FILE}: each entry must be a valid UUID.`,
        );
    }

    return validIds;
}
