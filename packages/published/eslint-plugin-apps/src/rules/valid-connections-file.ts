// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Rule } from 'eslint';
import type {
    Expression,
    ObjectExpression,
    Pattern,
    Program,
    Property,
    SpreadElement,
    VariableDeclarator,
} from 'estree';
import path from 'node:path';

const CONNECTIONS_BASENAME_RE = /^connections\.(ts|tsx|js|jsx)$/;
// Only `CONNECTIONS` (uppercase) is accepted, matching the build plugin's
// extractor at packages/plugins/apps/src/backend/extract-connections.ts.
const CONNECTIONS_EXPORT_NAME = 'CONNECTIONS';

type Messages =
    | 'missingExport'
    | 'notObjectLiteral'
    | 'duplicateExport'
    | 'spreadElement'
    | 'computedKey'
    | 'valueNotStaticString'
    | 'templateInterpolation';

// `@types/eslint` ships a nested copy of `@types/estree` whose ArrayExpression
// /Pattern/etc. types are structurally identical but a different TS module
// identity from the top-level `@types/estree` we depend on. We use named
// estree types internally for traversal (real type safety) and cast through
// `unknown` to `Rule.Node` only at `context.report` boundaries, where the two
// type universes meet.
const asRuleNode = (node: { type: string }): Rule.Node => node as unknown as Rule.Node;

const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Validate the structure of a Datadog Apps `connections.ts` file',
            url: 'https://github.com/DataDog/build-plugins/tree/main/packages/published/eslint-plugin-apps#valid-connections-file',
        },
        schema: [],
        messages: {
            missingExport:
                'connections file must define a top-level `export const CONNECTIONS = { … }`.',
            notObjectLiteral:
                '`export const CONNECTIONS` must be initialized with an object literal.',
            duplicateExport:
                'Multiple top-level `export const CONNECTIONS` declarations are not allowed.',
            spreadElement: 'Spread elements are not supported inside the connections object.',
            computedKey: 'Computed keys are not supported inside the connections object.',
            valueNotStaticString:
                'Value for "{{ key }}" must be a string literal; got {{ valueType }}.',
            templateInterpolation:
                'Value for "{{ key }}" must be a static string — template literals with interpolations are not allowed.',
        } satisfies Record<Messages, string>,
    },

    create(context) {
        const basename = path.basename(context.filename);
        if (!CONNECTIONS_BASENAME_RE.test(basename)) {
            return {};
        }

        return {
            'Program:exit'(programNode) {
                const program = programNode as unknown as Program;
                const matches: VariableDeclarator[] = [];

                for (const node of program.body) {
                    if (node.type !== 'ExportNamedDeclaration' || !node.declaration) {
                        continue;
                    }
                    if (node.declaration.type !== 'VariableDeclaration') {
                        continue;
                    }
                    for (const declarator of node.declaration.declarations) {
                        if (
                            declarator.id.type === 'Identifier' &&
                            declarator.id.name === CONNECTIONS_EXPORT_NAME
                        ) {
                            matches.push(declarator);
                        }
                    }
                }

                if (matches.length === 0) {
                    context.report({
                        node: programNode,
                        messageId: 'missingExport',
                    });
                    return;
                }

                if (matches.length > 1) {
                    for (let i = 1; i < matches.length; i += 1) {
                        context.report({
                            node: asRuleNode(matches[i]),
                            messageId: 'duplicateExport',
                        });
                    }
                }

                const declarator = matches[0];
                const init = unwrapTsAssertion(declarator.init);
                if (!init || init.type !== 'ObjectExpression') {
                    context.report({
                        node: asRuleNode(declarator.init ?? declarator),
                        messageId: 'notObjectLiteral',
                    });
                    return;
                }

                checkObject(init, context);
            },
        };
    },
};

function checkObject(obj: ObjectExpression, context: Rule.RuleContext): void {
    for (const property of obj.properties) {
        if (property.type === 'SpreadElement') {
            context.report({
                node: asRuleNode(property),
                messageId: 'spreadElement',
            });
            continue;
        }

        if (property.computed) {
            context.report({
                node: asRuleNode(property),
                messageId: 'computedKey',
            });
            continue;
        }

        const key = readKeyName(property);
        // Property values may be wrapped in TypeScript-specific assertion nodes
        // when parsed by @typescript-eslint/parser; unwrap before validating.
        const value = unwrapTsAssertion(property.value as Expression);

        if (value && value.type === 'Literal' && typeof value.value === 'string') {
            continue;
        }

        if (value && value.type === 'TemplateLiteral') {
            if (value.expressions.length === 0) {
                continue;
            }
            context.report({
                node: asRuleNode(value),
                messageId: 'templateInterpolation',
                data: { key },
            });
            continue;
        }

        const reported = (value ?? property.value) as Expression;
        context.report({
            node: asRuleNode(reported),
            messageId: 'valueNotStaticString',
            data: { key, valueType: reported.type },
        });
    }
}

function readKeyName(property: Property): string {
    if (property.key.type === 'Identifier') {
        return property.key.name;
    }
    if (property.key.type === 'Literal') {
        return String(property.key.value);
    }
    return '<unknown>';
}

/**
 * Unwrap TypeScript-specific assertion wrappers (`as const`, `as Foo`,
 * `<Foo>x`, `x!`) so we can validate the underlying expression. ESLint with
 * @typescript-eslint/parser preserves these as TSAsExpression / TSTypeAssertion
 * /TSSatisfiesExpression /TSNonNullExpression nodes; pure estree ASTs never
 * see them and `@types/estree` doesn't model them, so we work with a structural
 * shape here and cast back at the call sites.
 */
type EstreeNodeLike = { type: string; expression?: unknown };

function unwrapTsAssertion<T extends Expression | Pattern | SpreadElement | null | undefined>(
    node: T,
): T {
    let current = node as EstreeNodeLike | null | undefined;
    while (
        current &&
        (current.type === 'TSAsExpression' ||
            current.type === 'TSTypeAssertion' ||
            current.type === 'TSSatisfiesExpression' ||
            current.type === 'TSNonNullExpression')
    ) {
        current = current.expression as EstreeNodeLike | null | undefined;
    }
    return current as T;
}

export default rule;
