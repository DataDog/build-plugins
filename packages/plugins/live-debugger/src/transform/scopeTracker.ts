// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type * as t from '@babel/types';

import type { BabelTypesModule } from './babel-path.types';

export const MAX_CAPTURE_VARIABLES = 25;

export interface LocalVariableTemporalDeadZone {
    start: number;
    end: number;
}

export interface LocalVariableDeclaration {
    name: string;
    declarationEnd: number;
    temporalDeadZones: LocalVariableTemporalDeadZone[];
}

export function getParameterNames(
    functionNode: t.Function,
    typesModule: BabelTypesModule,
): string[] {
    const variables: string[] = [];

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

    if (variables.length > MAX_CAPTURE_VARIABLES) {
        return variables.slice(0, MAX_CAPTURE_VARIABLES);
    }

    return variables;
}

export function getLocalVariableDeclarations(
    functionNode: t.Function,
    typesModule: BabelTypesModule,
): LocalVariableDeclaration[] {
    const variables: LocalVariableDeclaration[] = [];

    if (typesModule.isBlockStatement(functionNode.body)) {
        const paramNames = functionNode.params.flatMap((param) =>
            getPatternIdentifiers(param, typesModule),
        );
        const paramSet = new Set(paramNames);
        const functionName =
            'id' in functionNode && typesModule.isIdentifier(functionNode.id)
                ? functionNode.id.name
                : '';

        for (const stmt of functionNode.body.body) {
            if (typesModule.isVariableDeclaration(stmt)) {
                const declarationEnd = stmt.end;
                if (declarationEnd == null) {
                    continue;
                }

                for (const decl of stmt.declarations) {
                    for (const name of getPatternIdentifiers(decl.id, typesModule)) {
                        if (!paramSet.has(name) && name !== functionName) {
                            variables.push({
                                name,
                                declarationEnd,
                                temporalDeadZones: [],
                            });
                        }
                    }
                }
            }
        }
    }

    const cappedVariables =
        variables.length > MAX_CAPTURE_VARIABLES
            ? variables.slice(0, MAX_CAPTURE_VARIABLES)
            : variables;

    if (typesModule.isBlockStatement(functionNode.body)) {
        const localNames = cappedVariables.map(({ name }) => name);
        const localNameSet = new Set(localNames);
        const temporalDeadZonesByName = getNestedTemporalDeadZonesByName(
            functionNode.body,
            localNameSet,
            typesModule,
        );

        for (const variable of cappedVariables) {
            variable.temporalDeadZones = temporalDeadZonesByName.get(variable.name) ?? [];
        }
    }

    return cappedVariables;
}

function getNestedTemporalDeadZonesByName(
    functionBody: t.BlockStatement,
    localNames: Set<string>,
    typesModule: BabelTypesModule,
): Map<string, LocalVariableTemporalDeadZone[]> {
    const temporalDeadZonesByName = new Map<string, LocalVariableTemporalDeadZone[]>();

    for (const stmt of functionBody.body) {
        collectTemporalDeadZonesFromStatement(
            stmt,
            localNames,
            temporalDeadZonesByName,
            typesModule,
        );
    }

    return temporalDeadZonesByName;
}

function collectTemporalDeadZonesFromStatement(
    stmt: t.Statement,
    localNames: Set<string>,
    temporalDeadZonesByName: Map<string, LocalVariableTemporalDeadZone[]>,
    typesModule: BabelTypesModule,
): void {
    if (typesModule.isFunctionDeclaration(stmt) || typesModule.isClassDeclaration(stmt)) {
        return;
    }

    if (typesModule.isBlockStatement(stmt)) {
        collectTemporalDeadZonesFromBlock(stmt, localNames, temporalDeadZonesByName, typesModule);
    } else if (typesModule.isIfStatement(stmt)) {
        collectTemporalDeadZonesFromStatement(
            stmt.consequent,
            localNames,
            temporalDeadZonesByName,
            typesModule,
        );
        if (stmt.alternate) {
            collectTemporalDeadZonesFromStatement(
                stmt.alternate,
                localNames,
                temporalDeadZonesByName,
                typesModule,
            );
        }
    } else if (
        typesModule.isForStatement(stmt) ||
        typesModule.isForInStatement(stmt) ||
        typesModule.isForOfStatement(stmt) ||
        typesModule.isWhileStatement(stmt) ||
        typesModule.isDoWhileStatement(stmt)
    ) {
        collectTemporalDeadZonesFromStatement(
            stmt.body,
            localNames,
            temporalDeadZonesByName,
            typesModule,
        );
    } else if (typesModule.isSwitchStatement(stmt)) {
        collectTemporalDeadZonesFromSwitch(stmt, localNames, temporalDeadZonesByName, typesModule);
    } else if (typesModule.isTryStatement(stmt)) {
        collectTemporalDeadZonesFromBlock(
            stmt.block,
            localNames,
            temporalDeadZonesByName,
            typesModule,
        );
        if (stmt.handler) {
            collectTemporalDeadZonesFromBlock(
                stmt.handler.body,
                localNames,
                temporalDeadZonesByName,
                typesModule,
            );
        }
        if (stmt.finalizer) {
            collectTemporalDeadZonesFromBlock(
                stmt.finalizer,
                localNames,
                temporalDeadZonesByName,
                typesModule,
            );
        }
    } else if (typesModule.isLabeledStatement(stmt) || typesModule.isWithStatement(stmt)) {
        collectTemporalDeadZonesFromStatement(
            stmt.body,
            localNames,
            temporalDeadZonesByName,
            typesModule,
        );
    }
}

function collectTemporalDeadZonesFromBlock(
    block: t.BlockStatement,
    localNames: Set<string>,
    temporalDeadZonesByName: Map<string, LocalVariableTemporalDeadZone[]>,
    typesModule: BabelTypesModule,
): void {
    addTemporalDeadZonesFromStatements(
        block.body,
        block.start,
        localNames,
        temporalDeadZonesByName,
        typesModule,
    );

    for (const stmt of block.body) {
        collectTemporalDeadZonesFromStatement(
            stmt,
            localNames,
            temporalDeadZonesByName,
            typesModule,
        );
    }
}

function collectTemporalDeadZonesFromSwitch(
    stmt: t.SwitchStatement,
    localNames: Set<string>,
    temporalDeadZonesByName: Map<string, LocalVariableTemporalDeadZone[]>,
    typesModule: BabelTypesModule,
): void {
    for (const caseClause of stmt.cases) {
        addTemporalDeadZonesFromStatements(
            caseClause.consequent,
            stmt.start,
            localNames,
            temporalDeadZonesByName,
            typesModule,
        );

        for (const consequent of caseClause.consequent) {
            collectTemporalDeadZonesFromStatement(
                consequent,
                localNames,
                temporalDeadZonesByName,
                typesModule,
            );
        }
    }
}

function addTemporalDeadZonesFromStatements(
    statements: t.Statement[],
    scopeStart: number | null | undefined,
    localNames: Set<string>,
    temporalDeadZonesByName: Map<string, LocalVariableTemporalDeadZone[]>,
    typesModule: BabelTypesModule,
): void {
    if (scopeStart == null) {
        return;
    }

    for (const stmt of statements) {
        if (typesModule.isVariableDeclaration(stmt) && stmt.kind !== 'var') {
            addVariableDeclarationTemporalDeadZones(
                stmt,
                scopeStart,
                localNames,
                temporalDeadZonesByName,
                typesModule,
            );
        } else if (typesModule.isClassDeclaration(stmt) && stmt.id) {
            addTemporalDeadZone(
                stmt.id.name,
                scopeStart,
                stmt.end,
                localNames,
                temporalDeadZonesByName,
            );
        }
    }
}

function addVariableDeclarationTemporalDeadZones(
    stmt: t.VariableDeclaration,
    scopeStart: number,
    localNames: Set<string>,
    temporalDeadZonesByName: Map<string, LocalVariableTemporalDeadZone[]>,
    typesModule: BabelTypesModule,
): void {
    for (const decl of stmt.declarations) {
        for (const name of getPatternIdentifiers(decl.id, typesModule)) {
            addTemporalDeadZone(name, scopeStart, stmt.end, localNames, temporalDeadZonesByName);
        }
    }
}

function addTemporalDeadZone(
    name: string,
    start: number,
    end: number | null | undefined,
    localNames: Set<string>,
    temporalDeadZonesByName: Map<string, LocalVariableTemporalDeadZone[]>,
): void {
    if (end == null || !localNames.has(name)) {
        return;
    }

    const existingZones = temporalDeadZonesByName.get(name) ?? [];
    existingZones.push({ start, end });
    temporalDeadZonesByName.set(name, existingZones);
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
