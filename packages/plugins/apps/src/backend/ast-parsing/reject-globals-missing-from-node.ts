// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode } from 'estree';

import { NODE_BACKEND_RUNTIME } from '../../constants';

import { forEachAmbientGlobalAccess } from './ambient-global-access';
import type { ModuleScopeAnalysis } from './module-scope';
import { ensureProgram } from './type-guards';

const POLYFILL_HINT = "Use fetch, or import a polyfill's export by name instead of the global";

// Node has no XMLHttpRequest or Deno, and the Node backend runtime doesn't pass --experimental-eventsource.
export const NODE_REPLACEMENT_HINTS: Readonly<Record<string, string>> = {
    XMLHttpRequest: POLYFILL_HINT,
    EventSource: POLYFILL_HINT,
    Deno: 'Use a Node API or a node: built-in import instead',
};
const NAMES_MISSING_FROM_NODE = Object.keys(NODE_REPLACEMENT_HINTS);
const GLOBALS_MISSING_FROM_NODE: ReadonlySet<string> = new Set(NAMES_MISSING_FROM_NODE);

export function rejectGlobalsMissingFromNode(
    ast: BaseNode,
    filePath: string,
    scopeAnalysis: ModuleScopeAnalysis,
): void {
    const program = ensureProgram(ast, filePath);

    forEachAmbientGlobalAccess(program, scopeAnalysis, GLOBALS_MISSING_FROM_NODE, {
        onNamedAccess(name) {
            throw new Error(
                `"${name}" is not available in the ${NODE_BACKEND_RUNTIME}. ` +
                    `${NODE_REPLACEMENT_HINTS[name]}: ${filePath}`,
            );
        },
    });
}
