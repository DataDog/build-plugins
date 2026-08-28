// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode, Expression } from 'estree';
import { builtinModules } from 'node:module';

import { ensureProgram, isTypeOnly, staticStringValue } from './type-guards';
import { walkAst } from './walk-ast';

const RESTRICTED_MODULES = new Set<string>(builtinModules);

function isRestrictedSource(source: string): boolean {
    return source.startsWith('node:') || RESTRICTED_MODULES.has(source);
}

// A declaration with no specifiers still evaluates the module for its side effects, so only a specifier list that's entirely type-only is safe to skip.
function hasRuntimeSpecifier(specifiers: readonly BaseNode[]): boolean {
    return specifiers.length === 0 || specifiers.some((specifier) => !isTypeOnly(specifier));
}

// Rejects static/dynamic imports of Node built-ins in `.backend.ts` files, which run in a restricted environment. Best-effort — doesn't catch `require()` or a runtime-computed specifier (see `rejectRestrictedGlobals` for bare network globals like `fetch`).
export function rejectNodeBuiltinImports(ast: BaseNode, filePath: string): void {
    const program = ensureProgram(ast, filePath);
    for (const node of program.body) {
        if (
            node.type === 'ImportDeclaration' &&
            !isTypeOnly(node) &&
            hasRuntimeSpecifier(node.specifiers)
        ) {
            rejectIfRestrictedSource(node.source, filePath);
            continue;
        }

        // A named re-export from a source loads the built-in module just like a regular import does.
        if (
            node.type === 'ExportNamedDeclaration' &&
            node.source &&
            !isTypeOnly(node) &&
            hasRuntimeSpecifier(node.specifiers)
        ) {
            rejectIfRestrictedSource(node.source, filePath);
            continue;
        }

        // `export * from` is its own Rollup node type, not an ExportNamedDeclaration, so it needs its own check.
        if (node.type === 'ExportAllDeclaration' && !isTypeOnly(node)) {
            rejectIfRestrictedSource(node.source, filePath);
        }
    }

    // A dynamic `import()` is an ImportExpression that can appear anywhere in the tree, not just program.body, so it needs its own walk.
    walkAst(program, null, {
        ImportExpression(node) {
            rejectIfRestrictedSource(node.source, filePath);
        },
    });
}

function rejectIfRestrictedSource(source: Expression, filePath: string): void {
    const value = staticStringValue(source);
    if (value === undefined || !isRestrictedSource(value)) {
        return;
    }

    throw new Error(
        `Importing Node built-in module "${value}" is not supported in backend function code. ` +
            `Backend functions run in a restricted environment: for networking, filesystem, or ` +
            `process access, use an Action Platform action ($.Actions or an @datadog/action-catalog ` +
            `typed wrapper) instead; for pure utility modules (e.g. path, url, util), use a ` +
            `runtime-independent package instead: ${filePath}`,
    );
}
