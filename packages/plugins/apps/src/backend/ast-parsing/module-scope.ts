// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as eslintScope from 'eslint-scope';
import type { Identifier, Node, Program } from 'estree';

import { walkAst } from './walk-ast';

/**
 * Generic eslint-scope facts for one parsed ES module.
 *
 * This intentionally has no action-catalog or connection ID concepts. Consumers
 * can use it to resolve an identifier node back to the declaration variable
 * eslint-scope found for that exact source location.
 */
export interface ModuleScopeAnalysis {
    scopeManager: eslintScope.ScopeManager;
    referencesByIdentifier: Map<Identifier, eslintScope.Reference>;
    moduleScope: eslintScope.Scope;
}

type NodeWithRange = Node & { start?: number; end?: number; range?: [number, number] };

export function analyzeModuleScope(ast: Program): ModuleScopeAnalysis {
    ensureRanges(ast);
    const scopeManager = eslintScope.analyze(ast, {
        ecmaVersion: 2022,
        ignoreEval: true,
        sourceType: 'module',
    });

    const referencesByIdentifier = new Map<Identifier, eslintScope.Reference>();
    for (const scope of scopeManager.scopes) {
        for (const reference of scope.references) {
            referencesByIdentifier.set(reference.identifier, reference);
        }
    }

    return {
        scopeManager,
        referencesByIdentifier,
        moduleScope: getModuleScope(scopeManager),
    };
}

export function resolveIdentifier(
    identifier: Identifier,
    scopeAnalysis: ModuleScopeAnalysis,
): eslintScope.Variable | undefined {
    return scopeAnalysis.referencesByIdentifier.get(identifier)?.resolved ?? undefined;
}

export function resolvesTo(
    identifier: Identifier,
    variables: ReadonlySet<eslintScope.Variable>,
    scopeAnalysis: ModuleScopeAnalysis,
): boolean {
    const variable = resolveIdentifier(identifier, scopeAnalysis);
    return !!variable && variables.has(variable);
}

export function isImportVariable(variable: eslintScope.Variable): boolean {
    return variable.defs.some((definition) => definition.type === 'ImportBinding');
}

export function getModuleVariable(
    name: string,
    scopeAnalysis: ModuleScopeAnalysis,
): eslintScope.Variable | undefined {
    return scopeAnalysis.moduleScope.set.get(name);
}

function getModuleScope(scopeManager: eslintScope.ScopeManager): eslintScope.Scope {
    return scopeManager.scopes.find((scope) => scope.type === 'module') ?? scopeManager.globalScope;
}

function ensureRanges(node: Node): void {
    walkAst(node, null, {
        _(child) {
            const nodeWithRange = child as NodeWithRange;
            if (
                !nodeWithRange.range &&
                typeof nodeWithRange.start === 'number' &&
                typeof nodeWithRange.end === 'number'
            ) {
                nodeWithRange.range = [nodeWithRange.start, nodeWithRange.end];
            }
        },
    });
}
