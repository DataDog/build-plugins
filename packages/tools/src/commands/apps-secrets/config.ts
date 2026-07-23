// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fs from 'fs';

export const DEFAULT_VITE_CONFIG_PATH = 'vite.config.ts';
const DATADOG_VITE_PLUGIN_PACKAGE = '@datadog/vite-plugin';

export class ConfigLocationError extends Error {}

// Narrowly scoped to the two common vite.config.ts shapes:
//   export default defineConfig({ plugins: [datadogVitePlugin({ ... })] })
//   export default { plugins: [datadogVitePlugin({ ... })] }
// Anything else (a function export, an async config, a config split across files) isn't
// safely editable without risking corrupting the user's file, so we fail loudly and let
// them add the option by hand instead.
const findDatadogPluginOptions = (mod: any): Record<string, unknown> => {
    const importEntry = Object.values<any>(mod.imports).find(
        (entry) => entry.from === DATADOG_VITE_PLUGIN_PACKAGE,
    );
    if (!importEntry) {
        throw new ConfigLocationError(
            `Could not find an import from "${DATADOG_VITE_PLUGIN_PACKAGE}" in the config file.`,
        );
    }

    const exportedDefault = mod.exports.default;
    const config =
        exportedDefault?.$type === 'function-call' ? exportedDefault.$args[0] : exportedDefault;
    const plugins = config?.plugins;
    if (!Array.isArray(plugins)) {
        throw new ConfigLocationError('Could not find a "plugins" array in the config file.');
    }

    const pluginCall = plugins.find((plugin: any) => plugin?.$callee === importEntry.local);
    if (!pluginCall) {
        throw new ConfigLocationError(
            `Could not find a call to "${importEntry.local}(...)" in the "plugins" array.`,
        );
    }

    if (!pluginCall.$args[0]) {
        pluginCall.$args[0] = {};
    }
    if (!pluginCall.$args[0].apps) {
        pluginCall.$args[0].apps = {};
    }
    return pluginCall.$args[0].apps;
};

export const readSecretConnections = async (configPath: string): Promise<string[]> => {
    if (!fs.existsSync(configPath)) {
        return [];
    }
    const { loadFile } = await import('magicast');
    const mod = await loadFile(configPath);
    const apps = findDatadogPluginOptions(mod);
    const secretConnections = apps.secretConnections;
    return Array.isArray(secretConnections) ? [...secretConnections] : [];
};

// Writes the full set of secret-store connection IDs back to the config, preserving
// formatting/comments elsewhere in the file. An empty array removes the field entirely,
// rather than leaving `secretConnections: []` behind.
export const writeSecretConnections = async (
    configPath: string,
    secretConnections: string[],
): Promise<void> => {
    if (!fs.existsSync(configPath)) {
        throw new ConfigLocationError(`Config file not found: ${configPath}`);
    }
    const { loadFile, writeFile } = await import('magicast');
    const mod = await loadFile(configPath);
    const apps = findDatadogPluginOptions(mod);

    if (secretConnections.length) {
        apps.secretConnections = secretConnections;
    } else {
        delete apps.secretConnections;
    }

    await writeFile(mod, configPath);
};

// Resolves which connection id a set/delete operation should target: the explicit id if
// given, or the sole id found in the config. Refuses to guess when there are several —
// picking the wrong one would mutate/delete the wrong secret store.
export const resolveConnectionId = async (
    explicit: string | undefined,
    configPath: string,
): Promise<string> => {
    if (explicit) {
        return explicit;
    }

    const stored = await readSecretConnections(configPath);
    if (stored.length === 1) {
        return stored[0];
    }
    if (stored.length === 0) {
        throw new ConfigLocationError(
            `No connection id provided, and none found in ${configPath}.`,
        );
    }
    throw new ConfigLocationError(
        `Multiple secret store connections found in ${configPath} — pass one explicitly: ${stored.join(', ')}`,
    );
};
