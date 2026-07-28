// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// Matches the `ddDebugId:"<uuid>"` literal the RUM plugin injects into each chunk's own content
// (see packages/plugins/rum/src/getSourceCodeContextSnippet.ts). The key is quoted in source
// (`JSON.stringify(context)`) but minifiers like terser strip quotes from object keys that are
// valid identifiers, so the built output can have either `"ddDebugId":"..."` or `ddDebugId:"..."`.
// Reading it back out of the file we're about to upload means we never have to trust a filename
// as a coordination key between the RUM plugin and this one, so it stays correct across any
// bundler renaming step.
const DEBUG_ID_RX = /"?ddDebugId"?:"([0-9a-fA-F-]{36})"/;

export const extractDebugId = (fileContent: string): string | undefined => {
    return DEBUG_ID_RX.exec(fileContent)?.[1];
};
