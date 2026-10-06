// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { parseAst } from 'vite';

// Non-literal so no bundler resolves `vite` at build time: this ships in every
// published package, but only runs under Vite.
const VITE_MODULE_ID = 'vite';

type ParseAst = typeof parseAst;

let parseAstPromise: Promise<ParseAst> | undefined;

/**
 * Loads the project's own Vite parser, so this plugin ships no parser of its own.
 * Imported dynamically: Vite's CJS entry (what `require` gets on Vite 5/6 without
 * require(esm)) doesn't expose `parseAst`.
 */
export function loadViteParseAst(): Promise<ParseAst> {
    parseAstPromise ??= importViteParseAst().catch((error: unknown) => {
        parseAstPromise = undefined;
        throw error;
    });
    return parseAstPromise;
}

async function importViteParseAst(): Promise<ParseAst> {
    const vite: unknown = await import(VITE_MODULE_ID);
    const viteModule = typeof vite === 'object' && vite !== null ? vite : {};
    const viteParseAst = readParseAst(viteModule);
    if (!isParseAst(viteParseAst)) {
        const version = 'version' in viteModule ? viteModule.version : undefined;
        const viteName = typeof version === 'string' ? `Vite ${version}` : 'the installed Vite';
        throw new Error(
            `Couldn't load parseAst from ${viteName}; local execution needs Vite 5 or later, loaded through its ESM entry.`,
        );
    }
    return viteParseAst;
}

// Vite's CJS entry defines `parseAst` as a getter that throws.
function readParseAst(viteModule: object): unknown {
    try {
        return 'parseAst' in viteModule ? viteModule.parseAst : undefined;
    } catch {
        return undefined;
    }
}

function isParseAst(value: unknown): value is ParseAst {
    return typeof value === 'function';
}
