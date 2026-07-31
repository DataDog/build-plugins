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

// The RUM plugin injects its snippet as a BEFORE-position banner (packages/plugins/rum/src/index.ts),
// so the ddDebugId literal always lands within the file's first couple hundred bytes, regardless
// of the file's total size — no need to read the whole (potentially large) minified bundle to
// find it. Measured against ~2.8k real built chunks (mixed bundlers/minifiers), the match always
// ended by byte 242; this leaves ~4x headroom for longer service/version strings.
export const DEBUG_ID_SEARCH_PREFIX_BYTES = 1024;

const matchDebugId = (fileContent: string): string | undefined => {
    return DEBUG_ID_RX.exec(fileContent)?.[1];
};

// Read only the first DEBUG_ID_SEARCH_PREFIX_BYTES bytes of the file, since that's all
// we need to find the ddDebugId literal and reading the whole (potentially large)
// minified bundle into memory would be wasteful.
const readFilePrefix = async (filePath: string): Promise<string> => {
    const fd = await fsp.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(DEBUG_ID_SEARCH_PREFIX_BYTES);
        const { bytesRead } = await fd.read(buffer, 0, DEBUG_ID_SEARCH_PREFIX_BYTES, 0);
        return buffer.toString('utf-8', 0, bytesRead);
    } finally {
        await fd.close();
    }
};

// Reads the minified file's own content and extracts the debug_id from it, instead of
// trusting a filename as a coordination key with the RUM plugin — the bundler may still
// rename the file after injection (e.g. webpack/rspack's realContentHash), but the content,
// and the debug_id embedded in it, is unaffected.
export const extractDebugId = async (filePath: string): Promise<string | undefined> => {
    const fileContent = await readFilePrefix(filePath).catch(() => undefined);
    return fileContent ? matchDebugId(fileContent) : undefined;
};
