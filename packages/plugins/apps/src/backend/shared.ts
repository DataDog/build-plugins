// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

function isPackageExportInstalled(packageExport: string, fromDir: string): boolean {
    try {
        require.resolve(packageExport, { paths: [fromDir] });
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if @datadog/action-catalog is installed using Node's module resolution.
 * Resolves from the given directory so the check works even when the plugin
 * itself is loaded from a different location (e.g. linked).
 */
export function isActionCatalogInstalled(fromDir: string): boolean {
    return isPackageExportInstalled('@datadog/action-catalog/action-execution', fromDir);
}

/** Check if the @datadog/apps-backend "JS Function with Actions" runtime factory is installed. */
export function isDatadogAppsBackendInstalled(fromDir: string): boolean {
    return isPackageExportInstalled('@datadog/apps-backend/runtime/jsFunctionWithActions', fromDir);
}

/** The import line to pull action-catalog's setExecuteActionImplementation into bundles. */
export const ACTION_CATALOG_IMPORT =
    "import { setExecuteActionImplementation } from '@datadog/action-catalog/action-execution';";

/** The import line that exposes @datadog/apps-backend backend context initialization. */
export const DATADOG_APPS_BACKEND_IMPORT = `\
import { buildRuntimeFromJsFunctionWithActions } from '@datadog/apps-backend/runtime/jsFunctionWithActions';
import { setBackend } from '@datadog/apps-backend/runtime';`;

/** Script snippet that supplies the backend runtime context to @datadog/apps. */
export const SET_BACKEND_CONTEXT_SNIPPET = `\
    if (typeof buildRuntimeFromJsFunctionWithActions === 'function' && typeof setBackend === 'function') {
        setBackend(buildRuntimeFromJsFunctionWithActions($));
    }`;

/** Script snippet that registers the $.Actions-based executeAction implementation at runtime. */
export const SET_EXECUTE_ACTION_SNIPPET = `\
    if (typeof setExecuteActionImplementation === 'function') {
        setExecuteActionImplementation(async (actionId, request) => {
            const actionPath = actionId.replace(/^com\\.datadoghq\\./, '');
            const pathParts = actionPath.split('.');
            let actionFn = $.Actions;
            for (const part of pathParts) {
                if (!actionFn) throw new Error('Action not found: ' + actionId);
                actionFn = actionFn[part];
            }
            if (typeof actionFn !== 'function') throw new Error('Action is not a function: ' + actionId);
            return actionFn(request);
        });
    }`;
