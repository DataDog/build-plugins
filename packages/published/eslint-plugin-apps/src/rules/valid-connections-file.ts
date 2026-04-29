// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Rule } from 'eslint';
import path from 'node:path';

// Local structural aliases. We intentionally do NOT import from 'estree' here:
// the monorepo has multiple copies of @types/estree resolved transitively, and
// pulling the named types causes TypeScript identity mismatches against
// `Rule.Node` (which references its own bundled estree). Structural typing is
// enough — we only branch on `.type` strings.
type EstreeNode = { type: string; [key: string]: unknown };

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
                const matches: EstreeNode[] = [];

                for (const node of programNode.body as EstreeNode[]) {
                    if (node.type !== 'ExportNamedDeclaration' || !node.declaration) {
                        continue;
                    }
                    const decl = node.declaration as EstreeNode;
                    if (decl.type !== 'VariableDeclaration') {
                        continue;
                    }
                    for (const declarator of decl.declarations as EstreeNode[]) {
                        const id = declarator.id as EstreeNode;
                        if (id.type === 'Identifier' && id.name === CONNECTIONS_EXPORT_NAME) {
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
                            node: matches[i] as unknown as Rule.Node,
                            messageId: 'duplicateExport',
                        });
                    }
                }

                const declarator = matches[0];
                const declaratorInit = declarator.init as EstreeNode | null | undefined;
                const init = unwrapTsAssertion(declaratorInit);
                if (!init || init.type !== 'ObjectExpression') {
                    context.report({
                        node: (declaratorInit ?? declarator) as unknown as Rule.Node,
                        messageId: 'notObjectLiteral',
                    });
                    return;
                }

                checkObject(init, context);
            },
        };
    },
};

function checkObject(obj: EstreeNode, context: Rule.RuleContext): void {
    for (const property of obj.properties as EstreeNode[]) {
        if (property.type === 'SpreadElement') {
            context.report({
                node: property as unknown as Rule.Node,
                messageId: 'spreadElement',
            });
            continue;
        }

        if (property.computed) {
            context.report({
                node: property as unknown as Rule.Node,
                messageId: 'computedKey',
            });
            continue;
        }

        const key = readKeyName(property);
        const propertyValue = property.value as EstreeNode;
        const value = unwrapTsAssertion(propertyValue);

        if (value && value.type === 'Literal' && typeof value.value === 'string') {
            continue;
        }

        if (value && value.type === 'TemplateLiteral') {
            const expressions = value.expressions as unknown[];
            if (expressions.length === 0) {
                continue;
            }
            context.report({
                node: value as unknown as Rule.Node,
                messageId: 'templateInterpolation',
                data: { key },
            });
            continue;
        }

        const reported = value ?? propertyValue;
        context.report({
            node: reported as unknown as Rule.Node,
            messageId: 'valueNotStaticString',
            data: { key, valueType: reported.type },
        });
    }
}

function readKeyName(property: EstreeNode): string {
    const key = property.key as EstreeNode;
    if (key.type === 'Identifier') {
        return String(key.name);
    }
    if (key.type === 'Literal') {
        return String(key.value);
    }
    return '<unknown>';
}

/**
 * Unwrap TypeScript-specific assertion wrappers (`as const`, `as Foo`,
 * `<Foo>x`, `x!`) so we can validate the underlying expression. ESLint with
 * @typescript-eslint/parser preserves these as TSAsExpression / TSTypeAssertion
 * /TSSatisfiesExpression /TSNonNullExpression nodes; pure estree ASTs never
 * see them.
 */
function unwrapTsAssertion(node: EstreeNode | null | undefined): EstreeNode | null | undefined {
    let current = node;
    while (
        current &&
        (current.type === 'TSAsExpression' ||
            current.type === 'TSTypeAssertion' ||
            current.type === 'TSSatisfiesExpression' ||
            current.type === 'TSNonNullExpression')
    ) {
        current = current.expression as EstreeNode | null | undefined;
    }
    return current;
}

export default rule;
