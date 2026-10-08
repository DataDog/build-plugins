// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode } from 'estree';

import { forEachAmbientGlobalAccess } from './ambient-global-access';
import { analyzeModuleScope } from './module-scope';
import type { ModuleScopeAnalysis } from './module-scope';
import { ensureProgram } from './type-guards';

const RESTRICTED_GLOBALS = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']);

// Node has no XMLHttpRequest, and Terrapin's runner doesn't pass --experimental-eventsource.
const GLOBALS_MISSING_FROM_NODE = new Set(['XMLHttpRequest', 'EventSource']);

// v1 backend functions have no raw network access in production and must go through an Action Platform action instead.
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
        onBulkCopy() {
            throw new Error(
                `Copying every property of "globalThis"/"global" at once (a rest destructure, ` +
                    `an object spread, or a call like Object.assign/Object.values) is not ` +
                    `supported in backend function code — it copies every ambient global, ` +
                    `including network-capable ones (${Array.from(RESTRICTED_GLOBALS).join(', ')}), ` +
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

export function rejectGlobalsMissingFromNode(
    ast: BaseNode,
    filePath: string,
    scopeAnalysis: ModuleScopeAnalysis,
): void {
    const program = ensureProgram(ast, filePath);

    forEachAmbientGlobalAccess(program, scopeAnalysis, GLOBALS_MISSING_FROM_NODE, {
        onNamedAccess(name) {
            throw new Error(
                `"${name}" is not available in the v2 backend function runtime, which runs on ` +
                    `Node. Use fetch, or import a polyfill's export by name instead of the global: ${filePath}`,
            );
        },
        onBulkCopy() {},
    });
}
