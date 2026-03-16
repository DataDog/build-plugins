// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Check if @datadog/action-catalog is installed using Node's module resolution.
 * Works across all package managers (npm, yarn, yarn PnP, pnpm).
 */
export function isActionCatalogInstalled(): boolean {
    try {
        require.resolve('@datadog/action-catalog/action-execution');
        return true;
    } catch {
        return false;
    }
}

/** The import line to pull action-catalog's setExecuteActionImplementation into bundles. */
export const ACTION_CATALOG_IMPORT =
    "import { setExecuteActionImplementation } from '@datadog/action-catalog/action-execution';";

/** Script snippet that registers the $.Actions-based executeAction implementation at runtime. */
export const SET_EXECUTE_ACTION_SNIPPET = `\
    if (typeof setExecuteActionImplementation === 'function') {
        setExecuteActionImplementation(async (actionId, request) => {
            const actionPath = actionId.replace(/^com\\\\.datadoghq\\\\./, '');
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
