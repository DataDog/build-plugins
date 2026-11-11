// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { ConnectionLabelRule } from '../backend/connection-labels';
import { CONNECTION_LABELS_UPGRADE_MESSAGE } from '../backend/connection-labels';
import { CONNECTION_LABELS_EXPORT, resolvePackageExport } from '../backend/shared';

// Non-literal so no bundler resolves `vite` at build time: this runs only under the app's Vite.
const VITE_MODULE_ID = 'vite';

/** The parts of action-catalog's connection label helper the plugin itself runs. */
export interface ConnectionLabelsHelper {
    connectionLabelPattern: RegExp;
    getResolvedConnectionIds: (runtimeContext: unknown, labels: string[]) => string[];
}

const helpersByPath = new Map<string, Promise<ConnectionLabelsLoad>>();

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
    // The generated entry imports these two, so a module without them can't be bundled.
    const entryImports = ['readResolvedConnections', 'swapConnectionLabel'].map((name) =>
        Reflect.get(helperModule, name),
    );
    if (
        !(pattern instanceof RegExp) ||
        typeof getIds !== 'function' ||
        entryImports.some((value) => typeof value !== 'function')
    ) {
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

export interface ConnectionLabelsLoad {
    helper: ConnectionLabelsHelper | undefined;
    labelRule: ConnectionLabelRule;
}

const UPGRADE_RULE: ConnectionLabelRule = { unavailableReason: CONNECTION_LABELS_UPGRADE_MESSAGE };

function toLoad(helper: ConnectionLabelsHelper | undefined): ConnectionLabelsLoad {
    const labelRule = helper ? { pattern: helper.connectionLabelPattern } : UPGRADE_RULE;
    return { helper, labelRule };
}

/**
 * The app's own copy of the helper, loaded through Vite's module runner, which runs the
 * package's ESM in any Node. Never rejects: without a usable helper, `labelRule` says why, so
 * only a build with a label call fails.
 */
export function loadConnectionLabelsHelper(projectRoot: string): Promise<ConnectionLabelsLoad> {
    const helperPath = resolvePackageExport(CONNECTION_LABELS_EXPORT, projectRoot);
    if (helperPath === undefined) {
        return Promise.resolve(toLoad(undefined));
    }
    const cached = helpersByPath.get(helperPath);
    if (cached) {
        return cached;
    }
    // A failed import isn't kept, so the next call retries it.
    const loading = importConnectionLabelsHelper(helperPath, projectRoot).then(toLoad, (error) => {
        if (helpersByPath.get(helperPath) === loading) {
            helpersByPath.delete(helperPath);
        }
        const reason = error instanceof Error ? error.message : String(error);
        const labelRule = {
            unavailableReason: `Couldn't load ${CONNECTION_LABELS_EXPORT}: ${reason}`,
        };
        return { helper: undefined, labelRule };
    });
    helpersByPath.set(helperPath, loading);
    return loading;
}

async function importConnectionLabelsHelper(
    helperPath: string,
    projectRoot: string,
): Promise<ConnectionLabelsHelper | undefined> {
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
}
