// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Minimal runtime stub injected into all chunks.
// `$dd_probes` is called unconditionally by instrumented functions, so it must
// exist before the Browser Debugger SDK initializes. The SDK's `init()` later
// replaces the stubbed globals with the real implementations.
const runtimeStubs = `if(typeof globalThis.$dd_probes==='undefined'){globalThis.$dd_probes=function(){}}`;
const buildMetadataGlobal = '__DD_LIVE_DEBUGGER_BUILD__' as const;

// Build the runtime bootstrap injected into all chunks. When
// `metadata.version` is configured, also expose build metadata so the
// Browser Debugger SDK can default its runtime version from the injected value.
export const getRuntimeBootstrap = (version?: string): string => {
    if (version === undefined) {
        return runtimeStubs;
    }

    return `${runtimeStubs};if(typeof globalThis.${buildMetadataGlobal}==='undefined'){globalThis.${buildMetadataGlobal}={version:${JSON.stringify(version)}}}`;
};
