// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* eslint-env browser */
/* global globalThis, Proxy */
/* eslint-disable no-console */

/**
 * Dynamic Instrumentation Runtime Helpers
 *
 * These functions provide the runtime support for Dynamic Instrumentation.
 * They are injected into the browser bundle and provide no-op stubs by default.
 */

const globalDI: any = globalThis;

// Global instrumentation state
globalDI.$dd_instrumentation = globalDI.$dd_instrumentation || {
    enabled: new Map<string, boolean>(),
    handlers: {
        start: (id: string, vars: any) => {
            if (globalDI.$dd_instrumentation?.debug) {
                console.log('[DD] Function start:', id, vars);
            }
        },
        return: (id: string, returnValue: any, vars: any) => {
            if (globalDI.$dd_instrumentation?.debug) {
                console.log('[DD] Function return:', id, returnValue, vars);
            }
            return returnValue;
        },
        throw: (id: string, error: any, vars: any) => {
            if (globalDI.$dd_instrumentation?.debug) {
                console.error('[DD] Function throw:', id, error, vars);
            }
        },
    },
    debug: false,
};

// Global runtime functions
globalDI.$dd_start = (id: string, vars: any) => {
    try {
        globalDI.$dd_instrumentation?.handlers.start(id, vars);
    } catch (e) {
        if (globalDI.$dd_instrumentation?.debug) {
            console.error('[DD] Error in $dd_start:', e);
        }
    }
};

globalDI.$dd_return = (id: string, returnValue: any, vars: any) => {
    try {
        return globalDI.$dd_instrumentation?.handlers.return(id, returnValue, vars);
    } catch (e) {
        if (globalDI.$dd_instrumentation?.debug) {
            console.error('[DD] Error in $dd_return:', e);
        }
        return returnValue;
    }
};

globalDI.$dd_throw = (id: string, error: any, vars: any) => {
    try {
        globalDI.$dd_instrumentation?.handlers.throw(id, error, vars);
    } catch (e) {
        if (globalDI.$dd_instrumentation?.debug) {
            console.error('[DD] Error in $dd_throw:', e);
        }
    }
};

// API functions
globalDI.$dd_enableProbe = (id: string) => {
    if (globalDI.$dd_instrumentation) {
        globalDI.$dd_instrumentation.enabled.set(id, true);
        if (globalDI.$dd_instrumentation.debug) {
            console.log('[DD] Enabled probe:', id);
        }
    }
};

globalDI.$dd_disableProbe = (id: string) => {
    if (globalDI.$dd_instrumentation) {
        globalDI.$dd_instrumentation.enabled.set(id, false);
        if (globalDI.$dd_instrumentation.debug) {
            console.log('[DD] Disabled probe:', id);
        }
    }
};

globalDI.$dd_enableDebug = () => {
    if (globalDI.$dd_instrumentation) {
        globalDI.$dd_instrumentation.debug = true;
        console.log('[DD] Debug mode enabled');
    }
};

// Create global probe flags dynamically
// Each instrumented function checks its own $dd_<hash> flag
const probeHandler = {
    get(target: any, prop: string) {
        if (prop.startsWith('$dd_')) {
            // All probe flags default to false (no-op)
            // Will be activated via Remote Config in future implementation
            return false;
        }
        return target[prop];
    },
};

// Apply proxy to globalThis for dynamic probe flags
if (typeof Proxy !== 'undefined') {
    try {
        Object.setPrototypeOf(globalDI, new Proxy(Object.getPrototypeOf(globalDI), probeHandler));
    } catch (e) {
        // Proxy not supported or failed, probe flags will be undefined (falsy)
    }
}
