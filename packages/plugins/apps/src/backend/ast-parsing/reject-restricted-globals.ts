// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode } from 'estree';

import { forEachAmbientGlobalAccess } from './ambient-global-access';
import { analyzeModuleScope } from './module-scope';
import type { ModuleScopeAnalysis } from './module-scope';
import { ensureProgram } from './type-guards';

const RESTRICTED_GLOBALS = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']);

// Reject network-capable globals (fetch, etc.) in `.backend.ts` files, since backend functions have no raw network access in production and must go through an Action Platform action instead; only pre-v2 (legacy) apps need this, as the planned Terrapin-based v2 sandbox lifts the restriction.
export function rejectRestrictedGlobals(
    ast: BaseNode,
    filePath: string,
    precomputedScopeAnalysis?: ModuleScopeAnalysis,
): void {
    const program = ensureProgram(ast, filePath);
    const scopeAnalysis = precomputedScopeAnalysis ?? analyzeModuleScope(program);

    forEachAmbientGlobalAccess(program, scopeAnalysis, RESTRICTED_GLOBALS, {
        onNamedAccess(name) {
            throwRestrictedGlobalError(name, filePath);
        },
        onRestDestructure() {
            throw new Error(
                `Destructuring "globalThis"/"global" with a rest pattern is not supported ` +
                    `in backend function code — it copies every ambient global, including ` +
                    `network-capable ones (${Array.from(RESTRICTED_GLOBALS).join(', ')}), ` +
                    `into a plain object: ${filePath}`,
            );
        },
    });
}

function throwRestrictedGlobalError(name: string, filePath: string): never {
    throw new Error(
        `Using "${name}" is not supported in backend function code. ` +
            `Backend functions cannot make raw network requests in production — ` +
            `use an Action Platform action ($.Actions or an @datadog/action-catalog ` +
            `typed wrapper) instead: ${filePath}`,
    );
}
