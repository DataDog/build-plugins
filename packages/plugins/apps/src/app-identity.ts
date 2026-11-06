// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDDEnvValue } from '@dd/core/helpers/env';
import { existsSync, readJsonSync } from '@dd/core/helpers/fs';
import type { Logger } from '@dd/core/types';
import path from 'path';

export const APP_CONFIG_FILE = 'datadog-app.config.json';

export type AppIdentity = {
    identifier?: string;
    name?: string;
};

// Nothing type-checks the app config, so a value that isn't a non-blank string is ignored.
const trimString = (value: unknown): string | undefined =>
    typeof value === 'string' ? value.trim() || undefined : undefined;

const readAppConfig = (projectRoot: string, log: Logger): Record<string, unknown> => {
    const configPath = path.join(projectRoot, APP_CONFIG_FILE);
    if (!existsSync(configPath)) {
        return {};
    }
    try {
        const config: unknown = readJsonSync(configPath);
        if (typeof config === 'object' && config !== null) {
            return { ...config };
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log.debug(`Could not read ${APP_CONFIG_FILE}: ${message}`);
    }
    return {};
};

/**
 * The app's identity for dev server queries, from `datadog-app.config.json`. The CLI passes the
 * identity it resolved to the builds it starts through `DATADOG_APPS_IDENTIFIER` and
 * `DATADOG_APPS_NAME`, which win.
 */
export const readAppIdentity = (projectRoot: string, log: Logger): AppIdentity => {
    const config = readAppConfig(projectRoot, log);
    const envIdentifier = getDDEnvValue('APPS_IDENTIFIER');
    const envName = getDDEnvValue('APPS_NAME');
    return {
        identifier: trimString(envIdentifier) ?? trimString(config.id),
        name: trimString(envName) ?? trimString(config.name),
    };
};
