// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { CONNECTION_LABELS_EXPORT, resolvePackageExport } from '../backend/shared';

// Non-literal so no bundler resolves `vite` at build time: this runs only under the app's Vite.
const VITE_MODULE_ID = 'vite';

/** The parts of action-catalog's connection label helper the plugin itself runs. */
export interface ConnectionLabelsHelper {
    connectionLabelPattern: RegExp;
    getResolvedConnectionIds: (runtimeContext: unknown, labels: string[]) => string[];
}

const helpersByProjectRoot = new Map<string, Promise<ConnectionLabelsHelper | undefined>>();

/** Undefined for a module without the expected exports, as for an action-catalog that predates them. */
export function toConnectionLabelsHelper(
    helperModule: unknown,
): ConnectionLabelsHelper | undefined {
    if (typeof helperModule !== 'object' || helperModule === null) {
        return undefined;
    }
    const pattern =
        'CONNECTION_LABEL_PATTERN' in helperModule
            ? helperModule.CONNECTION_LABEL_PATTERN
            : undefined;
    const getIds =
        'getResolvedConnectionIds' in helperModule
            ? helperModule.getResolvedConnectionIds
            : undefined;
    if (!(pattern instanceof RegExp) || typeof getIds !== 'function') {
        return undefined;
    }
    return {
        connectionLabelPattern: pattern,
        getResolvedConnectionIds: (runtimeContext, labels) => {
            const connectionIds: unknown = getIds(runtimeContext, labels);
            return Array.isArray(connectionIds)
                ? connectionIds.filter((value): value is string => typeof value === 'string')
                : [];
        },
    };
}

/**
 * The app's own copy of the helper, or undefined when it doesn't resolve, can't load or lacks
 * an export. Loaded through Vite's module runner, which runs the package's ESM in any Node.
 */
export function loadConnectionLabelsHelper(
    projectRoot: string,
): Promise<ConnectionLabelsHelper | undefined> {
    let helper = helpersByProjectRoot.get(projectRoot);
    if (!helper) {
        helper = importConnectionLabelsHelper(projectRoot);
        helpersByProjectRoot.set(projectRoot, helper);
    }
    return helper;
}

async function importConnectionLabelsHelper(
    projectRoot: string,
): Promise<ConnectionLabelsHelper | undefined> {
    const helperPath = resolvePackageExport(CONNECTION_LABELS_EXPORT, projectRoot);
    if (helperPath === undefined) {
        return undefined;
    }
    try {
        const vite: unknown = await import(VITE_MODULE_ID);
        const viteModule = typeof vite === 'object' && vite !== null ? vite : {};
        const runnerImport = 'runnerImport' in viteModule ? viteModule.runnerImport : undefined;
        if (typeof runnerImport !== 'function') {
            return undefined;
        }
        const imported: unknown = await runnerImport(helperPath, {
            root: projectRoot,
            logLevel: 'silent',
        });
        const helperModule =
            typeof imported === 'object' && imported !== null && 'module' in imported
                ? imported.module
                : undefined;
        return toConnectionLabelsHelper(helperModule);
    } catch {
        return undefined;
    }
}
