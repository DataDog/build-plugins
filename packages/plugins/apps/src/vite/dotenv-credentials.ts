// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import type { loadEnv, ResolvedConfig } from 'vite';

// On globalThis so it survives dev server restarts, which can load a fresh copy of this module,
// and a value removed from or edited in a .env file is not mistaken for a shell variable. Versioned,
// as another copy of the plugin in the process can store a different shape.
const LOADS_BY_ROOT_KEY = Symbol.for('@datadog/vite-plugin/apps/env-file-loads-by-root/v1');

// The plugin reads its own settings before configureServer and under alias names, so a file
// value would apply inconsistently and could override the shell.
const DATADOG_PREFIXES = ['DD_', 'DATADOG_'];

// Node, TLS, proxy, DNS, shell, binary-path and dynamic-loader settings apply to the whole dev
// server process, including the plugin's own requests to Datadog, so they are left to the shell.
// Matched case-insensitively, as Windows env names are.
export const PROCESS_SETTING_KEYS = {
    prefixes: ['NODE_', 'LD_', 'DYLD_', 'OPENSSL_'],
    names: [
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'NO_PROXY',
        'RES_OPTIONS',
        'LOCALDOMAIN',
        'HOSTALIASES',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
        'TZ',
        'PATH',
        'PATHEXT',
        'HOME',
        'USERPROFILE',
        'TMPDIR',
        'TMP',
        'TEMP',
        'SYSTEMROOT',
        'WINDIR',
        'COMSPEC',
        'ESBUILD_BINARY_PATH',
        'UV_THREADPOOL_SIZE',
        'UV_USE_IO_URING',
    ],
    infixes: ['_CA_'],
    suffixes: ['_CA'],
};

export type EnvFileConfig = Pick<ResolvedConfig, 'root' | 'mode' | 'envDir' | 'envPrefix'>;

export type EnvFileCredentials = {
    loaded: string[];
    ignoredDatadogKeys: string[];
    ignoredProcessKeys: string[];
    /** Keys another project root loaded first with a different value. */
    shadowedKeys: string[];
    /** Ends this load. The root's values are removed once every load for that root has ended. */
    drop: () => void;
};

type RootLoad = {
    values: Map<string, string>;
    // This root's values for keys another root had already set, applied if that root ends first.
    shadowedValues: Map<string, string>;
    openLoads: Map<object, () => boolean>;
};

function getLoadsByRoot(): Map<string, RootLoad> {
    const existing: unknown = Reflect.get(globalThis, LOADS_BY_ROOT_KEY);
    if (existing instanceof Map) {
        return existing;
    }
    const created = new Map<string, RootLoad>();
    Reflect.set(globalThis, LOADS_BY_ROOT_KEY, created);
    return created;
}

/** Unsets the given roots' values that are still in place and returns them. */
function takeLoadedValues(rootLoads: Iterable<RootLoad>): Map<string, string> {
    const takenValues = new Map<string, string>();
    for (const { values } of rootLoads) {
        for (const [key, value] of values) {
            if (process.env[key] === value) {
                takenValues.set(key, value);
                delete process.env[key];
            }
        }
    }
    return takenValues;
}

function restoreValues(values: Map<string, string>) {
    for (const [key, value] of values) {
        process.env[key] = value;
    }
}

/** Gives each unset key to the first open root that shadowed it. */
function handOffKeys(loadsByRoot: Map<string, RootLoad>, keys: Iterable<string>) {
    for (const key of keys) {
        if (key in process.env) {
            continue;
        }
        for (const rootLoad of loadsByRoot.values()) {
            const shadowedValue = rootLoad.shadowedValues.get(key);
            if (shadowedValue !== undefined) {
                rootLoad.shadowedValues.delete(key);
                rootLoad.values.set(key, shadowedValue);
                process.env[key] = shadowedValue;
                break;
            }
        }
    }
}

const isProcessSettingKey = (upperCaseKey: string): boolean =>
    PROCESS_SETTING_KEYS.prefixes.some((prefix) => upperCaseKey.startsWith(prefix)) ||
    PROCESS_SETTING_KEYS.names.includes(upperCaseKey) ||
    PROCESS_SETTING_KEYS.infixes.some((infix) => upperCaseKey.includes(infix)) ||
    PROCESS_SETTING_KEYS.suffixes.some((suffix) => upperCaseKey.endsWith(suffix));

function releaseRoot(loadsByRoot: Map<string, RootLoad>, root: string, rootLoad: RootLoad) {
    loadsByRoot.delete(root);
    const releasedValues = takeLoadedValues([rootLoad]);
    const releasedKeys = releasedValues.keys();
    handOffKeys(loadsByRoot, releasedKeys);
}

/** Ends every load whose `isActive` returns false, releasing roots left without an open load. */
function endInactiveLoads(loadsByRoot: Map<string, RootLoad>) {
    for (const [root, rootLoad] of loadsByRoot) {
        for (const [openLoad, isActive] of rootLoad.openLoads) {
            if (!isActive()) {
                rootLoad.openLoads.delete(openLoad);
            }
        }
        if (rootLoad.openLoads.size === 0) {
            releaseRoot(loadsByRoot, root, rootLoad);
        }
    }
}

/** Removes every root's loaded values, keeping any that something else changed since. For tests. */
export function dropEnvFileCredentials(): void {
    const loadsByRoot = getLoadsByRoot();
    const rootLoads = loadsByRoot.values();
    takeLoadedValues(rootLoads);
    loadsByRoot.clear();
}

/**
 * Copies keys from Vite's .env files (.env, .env.local, .env.[mode], .env.[mode].local) into
 * process.env for local execution, after dropping the previous load for the same `root`. Skips
 * variables the shell already set, keys Vite exposes to the frontend (`envPrefix`), Datadog
 * settings, and keys that change Node or process behavior. A key another root loaded first keeps
 * that root's value until it ends. A load whose `isActive` returns false ends at the next load or drop.
 */
export function loadEnvFileCredentials(
    loadEnvFromFiles: typeof loadEnv,
    { root, mode, envDir, envPrefix = 'VITE_' }: EnvFileConfig,
    isActive: () => boolean,
): EnvFileCredentials {
    const loadsByRoot = getLoadsByRoot();
    endInactiveLoads(loadsByRoot);
    const rootLoad: RootLoad = loadsByRoot.get(root) ?? {
        values: new Map(),
        shadowedValues: new Map(),
        openLoads: new Map(),
    };
    const publicPrefixes = Array.isArray(envPrefix) ? envPrefix : [envPrefix];
    // Unset while Vite reads the files, which would otherwise return them in place of the files'
    // values. This root's own are restored if the read fails.
    const otherRootLoads = [...loadsByRoot.values()].filter((other) => other !== rootLoad);
    const otherRootValues = takeLoadedValues(otherRootLoads);
    const previousValues = takeLoadedValues([rootLoad]);
    let envFileValues: Record<string, string>;
    try {
        // A '' prefix returns unprefixed keys too, merged with process.env, which the check below skips.
        envFileValues = envDir === false ? {} : loadEnvFromFiles(mode, envDir, '');
    } catch (error) {
        restoreValues(previousValues);
        throw error;
    } finally {
        restoreValues(otherRootValues);
    }
    loadsByRoot.set(root, rootLoad);
    rootLoad.values.clear();
    rootLoad.shadowedValues.clear();
    // Another dev server for this root, or the one a restart replaces, can still be running.
    const openLoad = {};
    rootLoad.openLoads.set(openLoad, isActive);
    const result: EnvFileCredentials = {
        loaded: [],
        ignoredDatadogKeys: [],
        ignoredProcessKeys: [],
        shadowedKeys: [],
        drop: () => {
            rootLoad.openLoads.delete(openLoad);
            endInactiveLoads(loadsByRoot);
        },
    };
    for (const [key, value] of Object.entries(envFileValues)) {
        const otherRootValue = otherRootValues.get(key);
        const isShellValue = key in process.env && otherRootValue === undefined;
        if (isShellValue || publicPrefixes.some((prefix) => key.startsWith(prefix))) {
            continue;
        }
        // Upper-cased because process.env is case-insensitive on Windows.
        const upperCaseKey = key.toUpperCase();
        if (DATADOG_PREFIXES.some((prefix) => upperCaseKey.startsWith(prefix))) {
            result.ignoredDatadogKeys.push(key);
            continue;
        }
        if (isProcessSettingKey(upperCaseKey)) {
            result.ignoredProcessKeys.push(key);
            continue;
        }
        if (otherRootValue !== undefined) {
            rootLoad.shadowedValues.set(key, value);
            if (value !== otherRootValue) {
                result.shadowedKeys.push(key);
            }
            continue;
        }
        process.env[key] = value;
        rootLoad.values.set(key, value);
        result.loaded.push(key);
    }
    const previousKeys = previousValues.keys();
    handOffKeys(loadsByRoot, previousKeys);
    return result;
}
