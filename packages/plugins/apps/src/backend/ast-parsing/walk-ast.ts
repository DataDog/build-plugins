// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode, Node as EstreeNode } from 'estree';

/**
 * Object passed to every visitor.
 *
 * `state` is shared for the whole walk. This helper intentionally does not
 * thread child-specific state because current AST analysis only needs one
 * shared collection/lookup object.
 */
export interface WalkAstContext<State> {
    state: State;
}

/**
 * Function called when the walker reaches a matching node.
 *
 * `Node` is the broad tree type passed to `walkAst`, while `CurrentNode` is the
 * narrowed node type for a specialized visitor such as `CallExpression`.
 */
export type WalkAstVisitor<Node extends BaseNode, State, CurrentNode extends BaseNode = Node> = (
    node: CurrentNode,
    context: WalkAstContext<State>,
) => void;

/**
 * Visitor map for concrete ESTree node types.
 *
 * The runtime walker is generic and does not special-case ESTree types. This
 * mapped type only exists to make visitor callbacks typed when users write
 * keys like `CallExpression` or `VariableDeclarator`.
 */
type SpecializedWalkAstVisitors<Node extends BaseNode, State> = {
    [Type in EstreeNode['type']]?: WalkAstVisitor<Node, State, Extract<EstreeNode, { type: Type }>>;
};

/**
 * Visitors accepted by `walkAst`.
 *
 * `_` is a universal visitor that runs for every node. Keys matching concrete
 * ESTree node types run only for nodes with that `type`.
 */
export type WalkAstVisitors<Node extends BaseNode, State> = SpecializedWalkAstVisitors<
    Node,
    State
> & {
    _?: WalkAstVisitor<Node, State>;
};

/**
 * Walks an ESTree-shaped AST without maintaining a hardcoded visitor-key table.
 *
 * Any object with a string `type` property is treated as a child node. Primitive
 * values, arrays entries without `type`, and metadata objects such as `loc` are
 * ignored.
 */
export function walkAst<Node extends BaseNode, State>(
    node: Node,
    state: State,
    visitors: WalkAstVisitors<Node, State>,
): void {
    const context: WalkAstContext<State> = { state };

    const visit = (currentNode: Node): void => {
        visitors._?.(currentNode, context);
        getSpecializedVisitor(currentNode, visitors)?.(currentNode, context);

        for (const key of Object.keys(currentNode)) {
            if (key === 'type') {
                continue;
            }

            visitChildren((currentNode as Record<string, unknown>)[key]);
        }
    };

    const visitChildren = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const item of value) {
                if (isAstNode(item)) {
                    visit(item as Node);
                }
            }
            return;
        }

        if (isAstNode(value)) {
            visit(value as Node);
        }
    };

    visit(node);
}

function isAstNode(value: unknown): value is BaseNode {
    return (
        typeof value === 'object' &&
        value !== null &&
        'type' in value &&
        typeof value.type === 'string'
    );
}

function getSpecializedVisitor<Node extends BaseNode, State>(
    node: Node,
    visitors: WalkAstVisitors<Node, State>,
): WalkAstVisitor<BaseNode, State> | undefined {
    return (visitors as Record<string, WalkAstVisitor<BaseNode, State> | undefined>)[node.type];
}
