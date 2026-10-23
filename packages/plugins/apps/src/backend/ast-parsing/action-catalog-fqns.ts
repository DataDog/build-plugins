// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Node, Program } from 'estree';

import { isStringLiteral } from './type-guards';
import { walkAst } from './walk-ast';

export const ACTION_FQN_PREFIX = 'com.datadoghq.';

type FunctionNode = Extract<
    Node,
    { type: 'FunctionDeclaration' | 'FunctionExpression' | 'ArrowFunctionExpression' }
>;

/**
 * Maps each exported function of an `@datadog/action-catalog` module to the one `com.datadoghq.*`
 * action FQN it calls the executor with. The import path alone doesn't name the action:
 * `aws/agent` exports `com.datadoghq.aws.bedrock.agent.*`.
 */
export function collectActionCatalogExportFqns(ast: Program): Map<string, string> {
    const functionsByName = collectTopLevelFunctions(ast);
    const fqnsByExport = new Map<string, string>();
    const addExport = (exportedName: string, fn: FunctionNode | undefined) => {
        const fqn = fn && getSingleActionFqn(fn);
        if (fqn) {
            fqnsByExport.set(exportedName, fqn);
        }
    };

    for (const node of ast.body) {
        if (node.type !== 'ExportNamedDeclaration' || node.source) {
            continue;
        }
        if (node.declaration?.type === 'FunctionDeclaration' && node.declaration.id) {
            addExport(node.declaration.id.name, node.declaration);
        }
        if (node.declaration?.type === 'VariableDeclaration') {
            for (const declarator of node.declaration.declarations) {
                if (declarator.id.type === 'Identifier') {
                    const fn = functionsByName.get(declarator.id.name);
                    addExport(declarator.id.name, fn);
                }
            }
        }
        for (const specifier of node.specifiers) {
            if (specifier.local.type !== 'Identifier' || specifier.exported.type !== 'Identifier') {
                continue;
            }
            const fn = functionsByName.get(specifier.local.name);
            addExport(specifier.exported.name, fn);
        }
    }

    return fqnsByExport;
}

function collectTopLevelFunctions(ast: Program): Map<string, FunctionNode> {
    const functionsByName = new Map<string, FunctionNode>();
    for (const statement of ast.body) {
        const node =
            statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
        if (node?.type === 'FunctionDeclaration' && node.id) {
            functionsByName.set(node.id.name, node);
        }
        if (node?.type !== 'VariableDeclaration' || node.kind !== 'const') {
            continue;
        }
        for (const declarator of node.declarations) {
            const init = declarator.init;
            if (
                declarator.id.type === 'Identifier' &&
                (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression')
            ) {
                functionsByName.set(declarator.id.name, init);
            }
        }
    }
    return functionsByName;
}

function getSingleActionFqn(fn: FunctionNode): string | undefined {
    const fqns = new Set<string>();
    walkAst(fn.body, fqns, {
        CallExpression(call, { state }) {
            const [firstArg] = call.arguments;
            if (isStringLiteral(firstArg) && firstArg.value.startsWith(ACTION_FQN_PREFIX)) {
                state.add(firstArg.value);
            }
        },
    });
    return fqns.size === 1 ? [...fqns][0] : undefined;
}
