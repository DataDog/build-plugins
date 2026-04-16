// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type * as t from '@babel/types';

import type { BabelTypesModule } from './babel-path.types';

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
    typesModule: BabelTypesModule,
): string[] {
    const variables: string[] = [];

    if (includeParams) {
        for (const param of functionNode.params) {
            for (const name of getPatternIdentifiers(param, typesModule)) {
                // TypeScript's `this` parameter (e.g. `fn(this: Type)`) is not
                // a real parameter and `this` can't be used as a shorthand
                // property name in object literals.
                if (name !== 'this') {
                    variables.push(name);
                }
            }
        }
    }

    if (includeLocals && typesModule.isBlockStatement(functionNode.body)) {
        const paramSet = new Set(
            functionNode.params.flatMap((p) => getPatternIdentifiers(p, typesModule)),
        );
        const functionName =
            'id' in functionNode && typesModule.isIdentifier(functionNode.id)
                ? functionNode.id.name
                : '';

        for (const stmt of functionNode.body.body) {
            if (typesModule.isVariableDeclaration(stmt)) {
                for (const decl of stmt.declarations) {
                    for (const name of getPatternIdentifiers(decl.id, typesModule)) {
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

function getPatternIdentifiers(pattern: t.Node, typesModule: BabelTypesModule): string[] {
    if (typesModule.isIdentifier(pattern)) {
        return [pattern.name];
    }

    if (typesModule.isRestElement(pattern)) {
        return typesModule.isIdentifier(pattern.argument)
            ? [pattern.argument.name]
            : getPatternIdentifiers(pattern.argument, typesModule);
    }

    if (typesModule.isAssignmentPattern(pattern)) {
        return getPatternIdentifiers(pattern.left, typesModule);
    }

    if (typesModule.isObjectPattern(pattern)) {
        return pattern.properties.flatMap((property) => {
            if (typesModule.isRestElement(property)) {
                return getPatternIdentifiers(property.argument, typesModule);
            }

            return getPatternIdentifiers(property.value, typesModule);
        });
    }

    if (typesModule.isArrayPattern(pattern)) {
        return pattern.elements.flatMap((element) => {
            if (!element) {
                return [];
            }

            return getPatternIdentifiers(element, typesModule);
        });
    }

    if (typesModule.isTSParameterProperty(pattern)) {
        return typesModule.isIdentifier(pattern.parameter) ? [pattern.parameter.name] : [];
    }

    return [];
}
