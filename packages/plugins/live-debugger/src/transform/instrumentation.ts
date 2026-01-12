// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// @ts-nocheck - Babel type conflicts between @babel/parser and @babel/types versions
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

import { buildVariableCaptureExpression, getVariablesToCapture } from './scopeTracker';

/**
 * Check if a function should be skipped based on comments
 */
export function shouldSkipFunction(
    functionPath: NodePath<t.Function>,
    skipComment: string,
): boolean {
    const node = functionPath.node;

    // Check leading comments
    if (node.leadingComments) {
        for (const comment of node.leadingComments) {
            if (comment.value.includes(skipComment)) {
                return true;
            }
        }
    }

    // Check comments on parent (for function expressions/arrow functions)
    if (functionPath.parentPath && functionPath.parentPath.node.leadingComments) {
        for (const comment of functionPath.parentPath.node.leadingComments) {
            if (comment.value.includes(skipComment)) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Check if function should be instrumented
 * Skips: generators, constructors, already instrumented
 */
export function canInstrumentFunction(functionPath: NodePath<t.Function>): boolean {
    const node = functionPath.node;

    // Skip generators
    if (node.generator) {
        return false;
    }

    // Skip constructors
    if (t.isClassMethod(node) && node.kind === 'constructor') {
        return false;
    }

    // Skip if already has try-catch (might be already instrumented)
    if (functionPath.node.body && t.isBlockStatement(functionPath.node.body)) {
        const body = functionPath.node.body.body;
        if (
            body.length === 1 &&
            t.isTryStatement(body[0]) &&
            body[0].handler &&
            body[0].handler.body.body.some(
                (stmt) => t.isThrowStatement(stmt) || t.isExpressionStatement(stmt),
            )
        ) {
            // Looks like it might already be instrumented
            return false;
        }
    }

    return true;
}

// Counter for generating unique probe variable names
let probeVarCounter = 0;

/**
 * Instrument a function with Dynamic Instrumentation code
 * Transforms the function body to add $dd_entry, $dd_return, $dd_throw calls
 * using the new $dd_probes() pattern.
 */
export function instrumentFunction(functionPath: NodePath<t.Function>, functionId: string): void {
    const node = functionPath.node;

    // Generate unique probe variable name for this function
    const probeVarName = `$dd_p${probeVarCounter++}`;

    // Get variables to capture
    const entryVars = getVariablesToCapture(functionPath, true, false); // Only params at entry
    const exitVars = getVariablesToCapture(functionPath, true, true); // Params + locals at exit

    // Convert arrow function with expression body to block statement
    if (t.isArrowFunctionExpression(node) && !t.isBlockStatement(node.body)) {
        node.body = t.blockStatement([t.returnStatement(node.body)]);
    }

    const body = node.body as t.BlockStatement;
    const originalStatements = body.body;

    // Create probe variable: const $dd_p0 = $dd_probes('<functionId>')
    const probeVarDecl = t.variableDeclaration('const', [
        t.variableDeclarator(
            t.identifier(probeVarName),
            t.callExpression(t.identifier('$dd_probes'), [t.stringLiteral(functionId)]),
        ),
    ]);

    // Build the $dd_entry call at entry: $dd_entry($dd_pN, this, {args})
    const argsObj = buildVariableCaptureExpression(entryVars);
    const startCall = t.expressionStatement(
        t.callExpression(t.identifier('$dd_entry'), [
            t.identifier(probeVarName),
            t.thisExpression(),
            argsObj,
        ]),
    );

    // Wrap start call with if ($dd_pN)
    const startIfStatement = t.ifStatement(t.identifier(probeVarName), startCall);

    // Transform return statements
    const transformedStatements: t.Statement[] = [];
    for (const stmt of originalStatements) {
        transformedStatements.push(
            transformReturnStatements(stmt, functionId, probeVarName, entryVars, exitVars),
        );
    }

    // Build catch block: if ($dd_pN) $dd_throw($dd_pN, error, this, args); throw e;
    const argsAtThrow = buildVariableCaptureExpression(entryVars);
    const catchClause = t.catchClause(
        t.identifier('e'),
        t.blockStatement([
            t.ifStatement(
                t.identifier(probeVarName),
                t.expressionStatement(
                    t.callExpression(t.identifier('$dd_throw'), [
                        t.identifier(probeVarName),
                        t.identifier('e'),
                        t.thisExpression(),
                        argsAtThrow,
                    ]),
                ),
            ),
            t.throwStatement(t.identifier('e')),
        ]),
    );

    // Build the try-catch block
    const tryStatement = t.tryStatement(
        t.blockStatement([startIfStatement, ...transformedStatements]),
        catchClause,
    );

    // Replace function body with instrumented version
    // Structure: const $dd_p = ...; try { ... } catch { ... }
    body.body = [probeVarDecl, tryStatement];
}

/**
 * Transform return statements to wrap with $dd_return
 */
function transformReturnStatements(
    statement: t.Statement,
    functionId: string,
    probeVarName: string,
    entryVars: string[],
    allVars: string[],
): t.Statement {
    if (t.isReturnStatement(statement)) {
        const returnValue = statement.argument || t.identifier('undefined');

        // Build: $dd_pN ? $dd_return($dd_pN, value, this, args, locals) : value
        const argsObj = buildVariableCaptureExpression(entryVars);
        const localsObj = buildVariableCaptureExpression(allVars);

        const instrumentedReturn = t.conditionalExpression(
            t.identifier(probeVarName),
            t.callExpression(t.identifier('$dd_return'), [
                t.identifier(probeVarName),
                returnValue,
                t.thisExpression(),
                argsObj,
                localsObj,
            ]),
            returnValue,
        );

        return t.returnStatement(instrumentedReturn);
    }

    // Recursively transform nested blocks
    if (t.isBlockStatement(statement)) {
        return t.blockStatement(
            statement.body.map((stmt) =>
                transformReturnStatements(stmt, functionId, probeVarName, entryVars, allVars),
            ),
        );
    }

    if (t.isIfStatement(statement)) {
        return t.ifStatement(
            statement.test,
            transformReturnStatements(
                statement.consequent,
                functionId,
                probeVarName,
                entryVars,
                allVars,
            ) as any,
            statement.alternate
                ? (transformReturnStatements(
                      statement.alternate,
                      functionId,
                      probeVarName,
                      entryVars,
                      allVars,
                  ) as any)
                : undefined,
        );
    }

    if (t.isWhileStatement(statement) || t.isDoWhileStatement(statement)) {
        return {
            ...statement,
            body: transformReturnStatements(
                statement.body,
                functionId,
                probeVarName,
                entryVars,
                allVars,
            ) as any,
        };
    }

    if (
        t.isForStatement(statement) ||
        t.isForInStatement(statement) ||
        t.isForOfStatement(statement)
    ) {
        return {
            ...statement,
            body: transformReturnStatements(
                statement.body,
                functionId,
                probeVarName,
                entryVars,
                allVars,
            ) as any,
        };
    }

    if (t.isSwitchStatement(statement)) {
        return t.switchStatement(
            statement.discriminant,
            statement.cases.map((caseClause) =>
                t.switchCase(
                    caseClause.test,
                    caseClause.consequent.map((stmt) =>
                        transformReturnStatements(
                            stmt,
                            functionId,
                            probeVarName,
                            entryVars,
                            allVars,
                        ),
                    ),
                ),
            ),
        );
    }

    if (t.isTryStatement(statement)) {
        return t.tryStatement(
            transformReturnStatements(
                statement.block,
                functionId,
                probeVarName,
                entryVars,
                allVars,
            ) as any,
            statement.handler
                ? t.catchClause(
                      statement.handler.param,
                      transformReturnStatements(
                          statement.handler.body,
                          functionId,
                          probeVarName,
                          entryVars,
                          allVars,
                      ) as any,
                  )
                : null,
            statement.finalizer
                ? (transformReturnStatements(
                      statement.finalizer,
                      functionId,
                      probeVarName,
                      entryVars,
                      allVars,
                  ) as any)
                : undefined,
        );
    }

    return statement;
}
