// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode } from 'estree';

import { describeRuntime } from '../../runtime-names';

import { forEachAmbientGlobalAccess } from './ambient-global-access';
import { analyzeModuleScope } from './module-scope';
import type { ModuleScopeAnalysis } from './module-scope';
import { ensureProgram } from './type-guards';

const RESTRICTED_GLOBALS = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']);

const POLYFILL_HINT = "Use fetch, or import a polyfill's export by name instead of the global";

// Node has no XMLHttpRequest or Deno, and the v2 runner doesn't pass --experimental-eventsource.
const NODE_REPLACEMENT_HINTS: Readonly<Record<string, string>> = {
    XMLHttpRequest: POLYFILL_HINT,
    EventSource: POLYFILL_HINT,
    Deno: 'Use a Node API or a node: built-in import instead',
};
const NAMES_MISSING_FROM_NODE = Object.keys(NODE_REPLACEMENT_HINTS);
const GLOBALS_MISSING_FROM_NODE: ReadonlySet<string> = new Set(NAMES_MISSING_FROM_NODE);

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

export class RestrictedGlobalError extends Error {
    constructor(
        message: string,
        readonly globalName: string,
    ) {
        super(message);
    }
}

export function isMissingFromNode(name: string): boolean {
    return GLOBALS_MISSING_FROM_NODE.has(name);
}

function throwRestrictedGlobalError(name: string, filePath: string): never {
    throw new RestrictedGlobalError(
        `Using "${name}" is not supported in backend function code. ` +
            `Backend functions cannot make raw network requests in production — ` +
            `use an Action Platform action ($.Actions or an @datadog/action-catalog ` +
            `typed wrapper) instead: ${filePath}`,
        name,
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
            const runtimeName = describeRuntime('v2');
            throw new Error(
                `"${name}" is not available in the ${runtimeName}. ` +
                    `${NODE_REPLACEMENT_HINTS[name]}: ${filePath}`,
            );
        },
        onBulkCopy() {},
    });
}
