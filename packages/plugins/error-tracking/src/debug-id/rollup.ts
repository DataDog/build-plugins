// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GlobalContext, PluginOptions } from '@dd/core/types';
import MagicString from 'magic-string';
import path from 'path';
import type { RenderedChunk } from 'rollup';

import { SUPPORTED_EXTENSIONS } from './constants';
import { getSnippet, stringToUUID } from './utils';

// Shared by rollup and vite: both consume rollup's `renderChunk` hook.
// We hash the chunk's code (content-based, deterministic) so the debug_id
// changes whenever the output changes, even when the filename has no hash.
export const getDebugIdRollupPlugin = (
    context: GlobalContext,
    debugIds: Map<string, string>,
): PluginOptions['rollup'] => ({
    renderChunk(code, chunk: RenderedChunk) {
        if (!SUPPORTED_EXTENSIONS.has(path.extname(chunk.fileName))) {
            return null;
        }
        const uuid = stringToUUID(code);
        const absolutePath = path.resolve(context.bundler.outDir, chunk.fileName);
        debugIds.set(absolutePath, uuid);

        const s = new MagicString(code);
        s.prepend(`${getSnippet(uuid)}\n`);

        return { code: s.toString(), map: s.generateMap({ file: chunk.fileName, hires: true }) };
    },
});
