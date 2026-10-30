// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getChunkDebugId } from '@dd/core/helpers/debugId';
import type { ChunkInfo } from '@dd/core/types';

import type { LiveDebuggerOptionsWithDefaults } from './types';

const buildMetadataGlobal = '__DD_LIVE_DEBUGGER_BUILD__' as const;

type BuildMetadata = {
    version?: string;
    debugId?: string;
};

// Return the per-chunk runtime bootstrap. It doesn't define `$dd_probes`, which
// instrumented functions only call once the SDK has defined it. It exposes build
// metadata to the Browser Debugger SDK:
//   - `version` (from `metadata.version`) defaults the SDK's runtime version.
//   - `debugId` is the chunk's debug ID, the same one its sourcemap is uploaded
//     with. Every sourcemap of a build is uploaded with the same git metadata,
//     so any chunk's debug ID identifies the build's repository and commit.
// The first chunk to execute defines the global; later chunks keep it.
// That first chunk is always an initial one, so only initial chunks carry the
// version: it changes on every build and would change the content, and so the
// hashed file name, of every lazily loaded chunk too.
export const getRuntimeBootstrap = ({
    version,
    debugId,
}: Pick<LiveDebuggerOptionsWithDefaults, 'version' | 'debugId'>) => {
    return (chunk?: ChunkInfo): string => {
        // Without chunk info there is no debug ID to match, so don't invent one.
        const chunkDebugId = debugId && chunk ? getChunkDebugId(chunk) : undefined;
        // Without chunk info, keep the version rather than risk losing it.
        const chunkVersion = !chunk || chunk.isInitial ? version : undefined;
        // Undefined fields are left out by JSON.stringify.
        const buildMetadata: BuildMetadata = { version: chunkVersion, debugId: chunkDebugId };
        const serializedBuildMetadata = JSON.stringify(buildMetadata);

        return `if(typeof globalThis.${buildMetadataGlobal}==='undefined'){globalThis.${buildMetadataGlobal}=${serializedBuildMetadata}}`;
    };
};
