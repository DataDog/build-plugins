// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode } from 'estree';
import { builtinModules } from 'node:module';

import { ensureProgram, isTypeOnly } from './type-guards';

const RESTRICTED_MODULES = new Set<string>(builtinModules);

function isRestrictedSource(source: string): boolean {
    return source.startsWith('node:') || RESTRICTED_MODULES.has(source);
}

/**
 * Reject static imports of Node built-in modules in `.backend.ts` files.
 * Backend functions run in a restricted environment with no direct Node
 * built-in or network access — everything, including raw HTTP requests,
 * must go through an Action Platform action ($.Actions or an
 * @datadog/action-catalog typed wrapper).
 *
 * This is a best-effort, defense-in-depth check on static `import` specifiers
 * only — it doesn't catch `require()` or dynamic `import()` of a computed
 * specifier. See also `rejectRestrictedGlobals`, which covers bare network
 * globals like `fetch` that need no import at all.
 */
export function rejectNodeBuiltinImports(ast: BaseNode, filePath: string): void {
    const program = ensureProgram(ast, filePath);
    for (const node of program.body) {
        if (node.type !== 'ImportDeclaration' || isTypeOnly(node)) {
            continue;
        }

        const source = node.source.value;
        if (typeof source === 'string' && isRestrictedSource(source)) {
            throw new Error(
                `Importing Node built-in module "${source}" is not supported in .backend.ts files. ` +
                    `Backend functions run in a restricted environment and must use an Action ` +
                    `Platform action ($.Actions or an @datadog/action-catalog typed wrapper) instead: ${filePath}`,
            );
        }
    }
}
