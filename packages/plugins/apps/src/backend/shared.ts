// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Check if @datadog/action-catalog is installed using Node's module resolution.
 * Resolves from the given directory (defaults to cwd) so the check works
 * even when the plugin itself is loaded from a different location (e.g. linked).
 */
export function isActionCatalogInstalled(fromDir: string): boolean {
    try {
        require.resolve('@datadog/action-catalog/action-execution', { paths: [fromDir] });
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if the Datadog Apps backend runtime adapter is installed.
 * Resolve the exported adapter subpath because the package intentionally has
 * no root export.
 */
export function isAppsBackendRuntimeInstalled(fromDir: string): boolean {
    try {
        require.resolve('@datadog/apps-backend/runtime/js-function-with-actions', {
            paths: [fromDir],
        });
        return true;
    } catch {
        return false;
    }
}

/** The import line to pull action-catalog's setExecuteActionImplementation into bundles. */
export const ACTION_CATALOG_IMPORT =
    "import { setExecuteActionImplementation } from '@datadog/action-catalog/action-execution';";

/** Imports used to install the jsFunctionWithActions backend runtime. */
export const APPS_BACKEND_RUNTIME_IMPORTS = `\
import { setBackendRuntime } from '@datadog/apps-backend/runtime';
import { createJsFunctionWithActionsRuntime } from '@datadog/apps-backend/runtime/js-function-with-actions';`;

/** Install the backend runtime using the invocation context hidden from customer code. */
export const SET_APPS_BACKEND_RUNTIME_SNIPPET =
    '    setBackendRuntime(createJsFunctionWithActionsRuntime($));';

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
