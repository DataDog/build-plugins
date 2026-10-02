// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import type { loadEnv, ResolvedConfig } from 'vite';

// On globalThis so it survives dev server restarts, which can load a fresh copy of this module,
// and a value removed from or edited in a .env file is not mistaken for a shell variable.
const LOADED_VALUES_KEY = Symbol.for('@datadog/vite-plugin/apps/env-file-values');

// The plugin reads its own settings before configureServer and under alias names, so a file
// value would apply inconsistently and could override the shell.
const DATADOG_PREFIXES = ['DD_', 'DATADOG_'];

export type EnvFileConfig = Pick<ResolvedConfig, 'mode' | 'envDir' | 'envPrefix'>;

export type EnvFileCredentials = {
    loaded: string[];
    ignoredDatadogKeys: string[];
};

function getLoadedValues(): Map<string, string> {
    const existing: unknown = Reflect.get(globalThis, LOADED_VALUES_KEY);
    if (existing instanceof Map) {
        return existing;
    }
    const created = new Map<string, string>();
    Reflect.set(globalThis, LOADED_VALUES_KEY, created);
    return created;
}

function dropPreviousLoad(loadedValues: Map<string, string>) {
    for (const [key, value] of loadedValues) {
        if (process.env[key] === value) {
            delete process.env[key];
        }
    }
    loadedValues.clear();
}

/** Removes the values the previous load set, keeping any that something else changed since. */
export function dropEnvFileCredentials(): void {
    dropPreviousLoad(getLoadedValues());
}

/**
 * Copies keys from Vite's .env files (.env, .env.local, .env.[mode], .env.[mode].local) into
 * process.env for local execution. Skips variables the shell already set, keys Vite exposes to
 * the frontend (`envPrefix`), and Datadog settings.
 */
export function loadEnvFileCredentials(
    loadEnvFromFiles: typeof loadEnv,
    { mode, envDir, envPrefix = 'VITE_' }: EnvFileConfig,
): EnvFileCredentials {
    const loadedValues = getLoadedValues();
    dropPreviousLoad(loadedValues);

    const result: EnvFileCredentials = { loaded: [], ignoredDatadogKeys: [] };
    if (envDir === false) {
        return result;
    }

    const publicPrefixes = Array.isArray(envPrefix) ? envPrefix : [envPrefix];
    // A '' prefix returns unprefixed keys too, merged with process.env, which the check below skips.
    const envFileValues = loadEnvFromFiles(mode, envDir, '');
    for (const [key, value] of Object.entries(envFileValues)) {
        if (key in process.env || publicPrefixes.some((prefix) => key.startsWith(prefix))) {
            continue;
        }
        // Upper-cased because process.env is case-insensitive on Windows.
        const upperCaseKey = key.toUpperCase();
        if (DATADOG_PREFIXES.some((prefix) => upperCaseKey.startsWith(prefix))) {
            result.ignoredDatadogKeys.push(key);
            continue;
        }
        process.env[key] = value;
        loadedValues.set(key, value);
        result.loaded.push(key);
    }
    return result;
}
