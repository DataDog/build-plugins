// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import * as t from '@babel/types';

export const MAX_CAPTURE_VARIABLES = 25;

/**
 * Get variable names to capture for a function.
 * Scans params and direct-child variable declarations to avoid
 * triggering Babel's expensive scope analysis.
 */
export function getVariableNames(
    functionNode: t.Function,
    includeParams: boolean,
    includeLocals: boolean,
): string[] {
    const variables: string[] = [];

    if (includeParams) {
        for (const param of functionNode.params) {
            for (const name of getPatternIdentifiers(param)) {
                // TypeScript's `this` parameter (e.g. `fn(this: Type)`) is not
                // a real parameter and `this` can't be used as a shorthand
                // property name in object literals.
                if (name !== 'this') {
                    variables.push(name);
                }
            }
        }
    }

    if (includeLocals && t.isBlockStatement(functionNode.body)) {
        const paramSet = new Set(functionNode.params.flatMap((p) => getPatternIdentifiers(p)));
        const functionName =
            'id' in functionNode && t.isIdentifier(functionNode.id) ? functionNode.id.name : '';

        for (const stmt of functionNode.body.body) {
            if (t.isVariableDeclaration(stmt)) {
                for (const decl of stmt.declarations) {
                    for (const name of getPatternIdentifiers(decl.id)) {
                        if (!paramSet.has(name) && name !== functionName) {
                            variables.push(name);
                        }
                    }
                }
            }
        }
    }

    if (variables.length > MAX_CAPTURE_VARIABLES) {
        return variables.slice(0, MAX_CAPTURE_VARIABLES);
    }

    return variables;
}

function getPatternIdentifiers(pattern: t.Node): string[] {
    if (t.isIdentifier(pattern)) {
        return [pattern.name];
    }

    if (t.isRestElement(pattern)) {
        return t.isIdentifier(pattern.argument)
            ? [pattern.argument.name]
            : getPatternIdentifiers(pattern.argument);
    }

    if (t.isAssignmentPattern(pattern)) {
        return getPatternIdentifiers(pattern.left);
    }

    if (t.isObjectPattern(pattern)) {
        return pattern.properties.flatMap((property) => {
            if (t.isRestElement(property)) {
                return getPatternIdentifiers(property.argument);
            }

            return getPatternIdentifiers(property.value);
        });
    }

    if (t.isArrayPattern(pattern)) {
        return pattern.elements.flatMap((element) => {
            if (!element) {
                return [];
            }

            return getPatternIdentifiers(element);
        });
    }

    if (t.isTSParameterProperty(pattern)) {
        return t.isIdentifier(pattern.parameter) ? [pattern.parameter.name] : [];
    }

    return [];
}
