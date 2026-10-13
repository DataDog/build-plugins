// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getChunkDebugId } from '@dd/core/helpers/debugId';
import type { ChunkInfo } from '@dd/core/types';

import type { LiveDebuggerOptionsWithDefaults } from './types';

// Minimal runtime stub injected into all chunks.
// `$dd_probes` is called unconditionally by instrumented functions, so it must
// exist before the Browser Debugger SDK initializes. The SDK's `init()` later
// replaces the stubbed globals with the real implementations.
const runtimeStubs = `if(typeof globalThis.$dd_probes==='undefined'){globalThis.$dd_probes=function(){}}`;
const buildMetadataGlobal = '__DD_LIVE_DEBUGGER_BUILD__' as const;

type BuildMetadata = {
    version?: string;
    debugId?: string;
};

// Return the per-chunk runtime bootstrap. Besides the stubs, it exposes build
// metadata to the Browser Debugger SDK:
//   - `version` (from `metadata.version`) defaults the SDK's runtime version.
//   - `debugId` is the chunk's debug ID, the same one its sourcemap is uploaded
//     with. Every sourcemap of a build is uploaded with the same git metadata,
//     so any chunk's debug ID identifies the build's repository and commit.
// The first chunk to execute defines the global; later chunks keep it.
export const getRuntimeBootstrap = ({
    version,
    debugId,
}: Pick<LiveDebuggerOptionsWithDefaults, 'version' | 'debugId'>) => {
    return (chunk?: ChunkInfo): string => {
        // Without chunk info there is no debug ID to match, so don't invent one.
        const chunkDebugId = debugId && chunk ? getChunkDebugId(chunk) : undefined;
        // Undefined fields are left out by JSON.stringify.
        const buildMetadata: BuildMetadata = { version, debugId: chunkDebugId };
        const serializedBuildMetadata = JSON.stringify(buildMetadata);

        return `${runtimeStubs};if(typeof globalThis.${buildMetadataGlobal}==='undefined'){globalThis.${buildMetadataGlobal}=${serializedBuildMetadata}}`;
    };
};
