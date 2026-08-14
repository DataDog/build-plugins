// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import fsp from 'fs/promises';

// Matches the `ddDebugId:"<uuid>"` literal the RUM plugin injects into each chunk's own content
// (see packages/plugins/rum/src/getSourceCodeContextSnippet.ts). The key is quoted in source
// (`JSON.stringify(context)`) but minifiers like terser strip quotes from object keys that are
// valid identifiers, so the built output can have either `"ddDebugId":"..."` or `ddDebugId:"..."`.
// Reading it back out of the file we're about to upload means we never have to trust a filename
// as a coordination key between the RUM plugin and this one, so it stays correct across any
// bundler renaming step.
const DEBUG_ID_RX = /"?ddDebugId"?:"([0-9a-fA-F-]{36})"/;

// Read progressively so the common case only needs the first KiB, while still supporting
// bundlers or transforms that place the injected snippet later in the artifact.
export const DEBUG_ID_SEARCH_CHUNK_BYTES = 1024;

// Keep enough content from the previous chunk to match a debug ID literal split across a read
// boundary. The longest supported literal is shorter than this overlap.
const DEBUG_ID_SEARCH_OVERLAP_CHARACTERS = 64;

const matchDebugId = (fileContent: string): string | undefined => {
    return DEBUG_ID_RX.exec(fileContent)?.[1];
};

// Search in fixed-size reads and stop as soon as the debug ID is found. Only a small overlap is
// retained between reads, so even the worst case (scanning to EOF) uses bounded memory.
const readDebugId = async (filePath: string): Promise<string | undefined> => {
    const fd = await fsp.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(DEBUG_ID_SEARCH_CHUNK_BYTES);
        let overlap = '';
        let position = 0;

        while (true) {
            const { bytesRead } = await fd.read(buffer, 0, DEBUG_ID_SEARCH_CHUNK_BYTES, position);
            if (bytesRead === 0) {
                return undefined;
            }

            const searchableContent = overlap + buffer.toString('utf-8', 0, bytesRead);
            const debugId = matchDebugId(searchableContent);
            if (debugId) {
                return debugId;
            }

            overlap = searchableContent.slice(-DEBUG_ID_SEARCH_OVERLAP_CHARACTERS);
            position += bytesRead;
        }
    } finally {
        await fd.close();
    }
};

// Reads the minified file's own content and extracts the debug_id from it, instead of
// trusting a filename as a coordination key with the RUM plugin — the bundler may still
// rename the file after injection (e.g. webpack/rspack's realContentHash), but the content,
// and the debug_id embedded in it, is unaffected.
export const extractDebugId = async (filePath: string): Promise<string | undefined> => {
    return readDebugId(filePath).catch(() => undefined);
};
