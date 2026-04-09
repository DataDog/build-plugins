// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { PluginName } from '@dd/core/types';

export const CONFIG_KEY = 'liveDebugger' as const;
export const PLUGIN_NAME: PluginName = 'datadog-live-debugger-plugin' as const;

// Skip instrumentation comment
export const SKIP_INSTRUMENTATION_COMMENT = '@dd-no-instrumentation';

// Minimal no-op stub injected into all chunks as a banner.
// $dd_probes is called unconditionally by every instrumented function;
// $dd_entry, $dd_return, and $dd_throw are guarded by `if (probe)` so
// they only need to exist once the SDK activates probes.
// When the Datadog Browser Debugger SDK loads, its init() overwrites
// $dd_probes with the real implementation.
export const RUNTIME_STUBS = `if(typeof globalThis.$dd_probes==='undefined'){globalThis.$dd_probes=function(){}}`;
