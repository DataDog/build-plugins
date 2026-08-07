// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode } from 'estree';

import { analyzeModuleScope } from './module-scope';
import { ensureProgram } from './type-guards';

const RESTRICTED_GLOBALS = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']);

/**
 * Reject references to network-capable globals in `.backend.ts` files.
 * Backend functions have no raw network access under today's v1 runtime —
 * Deno's `--allow-net` is off — so any outbound call must go through an
 * Action Platform action (`$.Actions` or an `@datadog/action-catalog` typed
 * wrapper), never a direct HTTP client. Import-specifier restriction alone
 * can't catch this: these are bare globals, not imports.
 *
 * This is the enforcement layer for a trap that's easy to fall into
 * otherwise: `fetch` works fine during local dev (nothing stopped it before
 * this check existed) but fails once the app is actually published, since
 * production's sandbox blocks it. A separate, complementary effort adds
 * AI-authoring guidance steering generated code away from `fetch` in the
 * first place — that reduces how often this gets written at all, but only
 * this build-time check actually guarantees it never ships, regardless of
 * whether the code came from an AI, a human, or a copy-pasted snippet.
 *
 * Backend functions' planned v2 (Terrapin-based) sandbox will lift this
 * restriction — legacy (pre-v2) apps are the ones that need it.
 *
 * This is a best-effort, defense-in-depth check: it flags any reference to one
 * of these names that eslint-scope can't resolve to a declaration in this
 * module (i.e. it falls through to the ambient global instead of a local
 * variable or import that happens to share the name).
 */
export function rejectRestrictedGlobals(ast: BaseNode, filePath: string): void {
    const program = ensureProgram(ast, filePath);
    const scopeAnalysis = analyzeModuleScope(program);

    for (const [identifier, reference] of scopeAnalysis.referencesByIdentifier) {
        if (!RESTRICTED_GLOBALS.has(identifier.name) || reference.resolved) {
            continue;
        }

        throw new Error(
            `Using "${identifier.name}" is not supported in .backend.ts files. ` +
                `Backend functions cannot make raw network requests in production — ` +
                `use an Action Platform action ($.Actions or an @datadog/action-catalog ` +
                `typed wrapper) instead: ${filePath}`,
        );
    }
}
