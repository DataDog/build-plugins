// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type _traverse from '@babel/traverse';
import type * as BabelTypes from '@babel/types';
import type MagicStringType from 'magic-string';
import type { SourceMap } from 'magic-string';

import { SKIP_INSTRUMENTATION_COMMENT } from '../constants';
import type { FunctionKind } from '../types';

import type { BabelPath } from './babel-path.types';
import { resolveCjsDefaultExport } from './cjs-interop';
import { generateFunctionId, getFunctionName } from './functionId';
import { canInstrumentFunction, shouldSkipFunction } from './instrumentation';
import { getVariableNames } from './scopeTracker';

type TraverseFn = typeof _traverse;
type ParseFn = (
    code: string,
    options: {
        sourceType: 'unambiguous';
        plugins: string[];
        sourceFilename: string;
    },
) => BabelTypes.File;
type BabelTypesModule = typeof import('@babel/types');
type MagicStringConstructor = typeof import('magic-string').default;

let hasLoadedTransformRuntime = false;
let parse: ParseFn;
let traverse: TraverseFn;
let babelTypes: BabelTypesModule;
let MagicString: MagicStringConstructor;

const getTransformRuntime = (): void => {
    if (!hasLoadedTransformRuntime) {
        // Lazy-load heavy Babel deps only when we actually instrument a file.
        // `require()` (not `import()`) because the transform hook is synchronous.
        // The `as` casts are unavoidable: `require()` returns untyped values.
        // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
        parse = (require('@babel/parser') as { parse: ParseFn }).parse;
        // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
        traverse = resolveCjsDefaultExport(require('@babel/traverse')) as TraverseFn;
        // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
        babelTypes = require('@babel/types') as BabelTypesModule;
        // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
        MagicString = resolveCjsDefaultExport(require('magic-string')) as MagicStringConstructor;

        if (!parse || !traverse || !babelTypes || !MagicString) {
            throw new Error('Failed to load Live Debugger transform runtime.');
        }

        hasLoadedTransformRuntime = true;
    }
};

const HAS_FUNCTION_SYNTAX = /\bfunction\b|=>|\bclass\b|\)\s*\{/;

interface ReturnInfo {
    start: number;
    end: number;
    argStart: number | undefined;
    argEnd: number | undefined;
}

interface FunctionTarget {
    bodyStart: number;
    bodyEnd: number;
    functionEnd: number;
    isExpressionBody: boolean;
    needsTrailingReturn: boolean;
    bodyParenStart: number | undefined;
    directivesEnd: number | undefined;
    functionId: string;
    probeVarName: string;
    probeIdx: string;
    entryVars: string[];
    exitVars: string[];
    returns: ReturnInfo[];
}

export interface TransformOptions {
    code: string;
    filePath: string;
    buildRoot: string;
    honorSkipComments: boolean;
    functionTypes: FunctionKind[] | undefined;
    namedOnly: boolean;
}

export interface TransformResult {
    code: string;
    map?: SourceMap;
    failedCount: number;
    instrumentedCount: number;
    skippedByCommentCount: number;
    skippedFileCount: number;
    skippedUnsupportedCount: number;
    totalFunctions: number;
}

/**
 * Transform JavaScript code to add Live Debugger instrumentation.
 * Uses Babel to parse and read the AST, then MagicString for injection.
 */
export function transformCode(options: TransformOptions): TransformResult {
    const { code, filePath, buildRoot, honorSkipComments, functionTypes, namedOnly } = options;

    let failedCount = 0;
    let instrumentedCount = 0;
    let skippedByCommentCount = 0;
    let skippedUnsupportedCount = 0;
    let totalFunctions = 0;

    if (containsUnsupportedImports(code)) {
        return {
            code,
            failedCount,
            instrumentedCount,
            skippedByCommentCount,
            skippedFileCount: 1,
            skippedUnsupportedCount,
            totalFunctions,
        };
    }

    if (!HAS_FUNCTION_SYNTAX.test(code)) {
        return {
            code,
            failedCount,
            instrumentedCount,
            skippedByCommentCount,
            skippedFileCount: 0,
            skippedUnsupportedCount,
            totalFunctions,
        };
    }

    getTransformRuntime();
    const ast = parse(code, {
        sourceType: 'unambiguous',
        plugins: ['jsx', 'typescript'],
        sourceFilename: filePath,
    });

    // Read-only traverse: collect instrumentation targets without mutating the AST
    const targets: FunctionTarget[] = [];
    const anonymousCountByParent = new Map<BabelTypes.Node, number>();
    let probeVarCounter = 0;

    // @babel/parser and @babel/traverse bundle separate copies of @babel/types,
    // causing a structural type mismatch. The cast is safe: parse() returns a
    // valid AST that traverse() accepts at runtime.
    traverse(ast as unknown as BabelTypes.Node, {
        Function(path: BabelPath<BabelTypes.Function>) {
            totalFunctions++;

            if (!canInstrumentFunction(path)) {
                skippedUnsupportedCount++;
                return;
            }

            if (honorSkipComments && shouldSkipFunction(path, SKIP_INSTRUMENTATION_COMMENT)) {
                skippedByCommentCount++;
                return;
            }

            if (functionTypes && !functionTypes.includes(getFunctionKind(path.node, babelTypes))) {
                skippedUnsupportedCount++;
                return;
            }

            if (namedOnly && !getFunctionName(path)) {
                skippedUnsupportedCount++;
                return;
            }

            // O(1) anonymous sibling index via pre-indexed Map
            let anonymousSiblingIndex = 0;
            if (!getFunctionName(path)) {
                const parentNode = path.parentPath?.node;
                if (parentNode) {
                    anonymousSiblingIndex = anonymousCountByParent.get(parentNode) || 0;
                    anonymousCountByParent.set(parentNode, anonymousSiblingIndex + 1);
                }
            }

            const functionId = generateFunctionId(filePath, buildRoot, path, anonymousSiblingIndex);

            try {
                const node = path.node;
                const idx = probeVarCounter++;
                const probeVarName = `$dd_p${idx}`;
                const entryVars = getVariableNames(node, true, false);
                const exitVars = getVariableNames(node, true, true);

                const isExpressionBody =
                    babelTypes.isArrowFunctionExpression(node) &&
                    !babelTypes.isBlockStatement(node.body);

                const returns: ReturnInfo[] = [];
                const needsTrailingReturn =
                    isExpressionBody ||
                    !babelTypes.isBlockStatement(node.body) ||
                    !alwaysReturns(node.body.body, babelTypes);
                if (!isExpressionBody && babelTypes.isBlockStatement(node.body)) {
                    collectReturnStatements(node.body.body, returns, babelTypes);
                }

                let directivesEnd: number | undefined;
                if (
                    !isExpressionBody &&
                    babelTypes.isBlockStatement(node.body) &&
                    node.body.directives.length > 0
                ) {
                    const lastDirective = node.body.directives[node.body.directives.length - 1];
                    directivesEnd = lastDirective.end!;
                }

                targets.push({
                    bodyStart: node.body.start!,
                    bodyEnd: node.body.end!,
                    functionEnd: node.end!,
                    isExpressionBody,
                    needsTrailingReturn,
                    bodyParenStart:
                        isExpressionBody && typeof node.body.extra?.parenStart === 'number'
                            ? node.body.extra.parenStart
                            : undefined,
                    directivesEnd,
                    functionId,
                    probeVarName,
                    probeIdx: String(idx),
                    entryVars,
                    exitVars,
                    returns,
                });

                instrumentedCount++;
            } catch (error) {
                failedCount++;
            }
        },
    });

    if (instrumentedCount === 0) {
        return {
            code,
            failedCount,
            instrumentedCount,
            skippedByCommentCount,
            skippedFileCount: 0,
            skippedUnsupportedCount,
            totalFunctions,
        };
    }

    const s = new MagicString(code);

    // Process inner (deeper) functions before outer ones so that MagicString
    // appendLeft calls at shared positions (e.g. where an outer return wraps
    // an inner arrow function) stack in the correct order.
    for (let i = targets.length - 1; i >= 0; i--) {
        injectInstrumentation(s, code, targets[i]);
    }

    return {
        code: s.toString(),
        // Known limitation: hires: false gives line-level source map granularity only.
        // Column-level accuracy (hires: true or 'boundary') would be needed for
        // minified code or precise debugger positioning, but is not required for
        // RUM Error Tracking stack traces which reference lines.
        map: s.generateMap({ source: filePath, hires: false }),
        failedCount,
        instrumentedCount,
        skippedByCommentCount,
        skippedFileCount: 0,
        skippedUnsupportedCount,
        totalFunctions,
    };
}

/**
 * Inject instrumentation for a single function using MagicString.
 *
 * Uses appendLeft exclusively (no overwrite) to avoid conflicts
 * with nested function instrumentation in the same source range.
 */
function injectInstrumentation(s: MagicStringType, code: string, target: FunctionTarget): void {
    const {
        probeVarName,
        probeIdx,
        functionId,
        entryVars,
        exitVars,
        returns,
        bodyStart,
        bodyEnd,
        functionEnd,
        isExpressionBody,
        bodyParenStart,
        directivesEnd,
    } = target;

    const entryHelper = `$dd_e${probeIdx}`;
    const exitHelper = `$dd_l${probeIdx}`;
    const rvVarName = `$dd_rv${probeIdx}`;

    const entryVarsList = entryVars.join(', ');
    const exitVarsList = exitVars.join(', ');

    const shared = entryVarsList === exitVarsList;
    const snapshotHelper = shared ? entryHelper : exitHelper;

    // TODO: functionId is not escaped — if it contains a single quote (e.g. quoted method names),
    // the generated code will be invalid. Escaping is not currently supported.
    const probeDecl = `const ${probeVarName} = $dd_probes('${functionId}');`;
    const entryHelperDecl = `const ${entryHelper} = () => ({${entryVarsList}});`;
    const exitHelperDecl = shared ? '' : `const ${exitHelper} = () => ({${exitVarsList}});`;
    const entryCall = `if (${probeVarName}) $dd_entry(${probeVarName}, this, ${entryHelper}());`;
    const catchBlock = `catch(e) { if (${probeVarName}) $dd_throw(${probeVarName}, e, this, ${entryHelper}()); throw e; }`;

    if (isExpressionBody) {
        // Arrow expression body: (a) => expr
        // Wrap in block body with temp variable to avoid duplicating nested expressions

        // Handle parenthesized expression bodies: () => ({key: value})
        // The parentheses must be removed when converting to a block body,
        // otherwise the output would be => ({block_code}) which is a syntax error.
        // Uses Babel's `extra.parenStart` for the opening `(` and scans between
        // bodyEnd and functionEnd for the closing `)`.
        if (bodyParenStart != null) {
            let parenAfter = -1;
            for (let i = bodyEnd; i < functionEnd; i++) {
                if (code[i] === ')') {
                    parenAfter = i;
                    break;
                }
            }
            if (parenAfter !== -1) {
                s.remove(bodyParenStart, bodyParenStart + 1);
                s.remove(parenAfter, parenAfter + 1);
            }
        }

        const prefix = [
            '{',
            probeDecl,
            entryHelperDecl,
            exitHelperDecl,
            'try {',
            entryCall,
            `const ${rvVarName} = `,
        ]
            .filter(Boolean)
            .join('\n');

        const suffix = [
            ';',
            `if (${probeVarName}) $dd_return(${probeVarName}, ${rvVarName}, this, ${entryHelper}(), ${snapshotHelper}());`,
            `return ${rvVarName};`,
            `} ${catchBlock}`,
            '}',
        ].join('\n');

        s.appendLeft(bodyStart, prefix);
        s.appendLeft(bodyEnd, suffix);
    } else {
        // Block body function
        const preamble = [
            '',
            probeDecl,
            entryHelperDecl,
            'try {',
            exitHelperDecl,
            `let ${rvVarName};`,
            entryCall,
        ]
            .filter(Boolean)
            .join('\n');

        const postambleParts = [''];
        if (target.needsTrailingReturn) {
            postambleParts.push(
                `if (${probeVarName}) $dd_return(${probeVarName}, undefined, this, ${entryHelper}(), ${snapshotHelper}());`,
            );
        }
        postambleParts.push(`} ${catchBlock}`, '');
        const postamble = postambleParts.join('\n');

        const preambleInsertPos = directivesEnd ?? bodyStart + 1;
        s.appendLeft(preambleInsertPos, directivesEnd != null ? `\n${preamble}` : preamble);

        // Wrap return statements BEFORE inserting the postamble so that when
        // a semicolon-free final return shares its argEnd position with
        // bodyEnd - 1, appendLeft stacks the return suffix before the postamble.
        for (const ret of returns) {
            if (ret.argStart != null && ret.argEnd != null) {
                // return EXPR; → return ($dd_rvN = EXPR, probe ? $dd_return(...) : $dd_rvN);
                s.appendLeft(ret.argStart, `(${rvVarName} = `);
                s.appendLeft(
                    ret.argEnd,
                    `, ${probeVarName} ? $dd_return(${probeVarName}, ${rvVarName}, this, ${entryHelper}(), ${snapshotHelper}()) : ${rvVarName})`,
                );
            } else {
                // return; → if (probe) $dd_return(...); return;
                s.appendLeft(
                    ret.start,
                    `if (${probeVarName}) $dd_return(${probeVarName}, undefined, this, ${entryHelper}(), ${snapshotHelper}()); `,
                );
            }
        }

        s.appendLeft(bodyEnd - 1, postamble);
    }
}

/**
 * Recursively collect return statements within a function body,
 * skipping nested function/class bodies.
 */
function collectReturnStatements(
    statements: BabelTypes.Statement[],
    returns: ReturnInfo[],
    typesModule: BabelTypesModule,
): void {
    for (const stmt of statements) {
        if (typesModule.isReturnStatement(stmt)) {
            returns.push({
                start: stmt.start!,
                end: stmt.end!,
                argStart: stmt.argument?.start ?? undefined,
                argEnd: stmt.argument?.end ?? undefined,
            });
            continue;
        }

        if (typesModule.isFunctionDeclaration(stmt) || typesModule.isClassDeclaration(stmt)) {
            continue;
        }

        if (typesModule.isBlockStatement(stmt)) {
            collectReturnStatements(stmt.body, returns, typesModule);
        } else if (typesModule.isIfStatement(stmt)) {
            collectReturnStatements([stmt.consequent], returns, typesModule);
            if (stmt.alternate) {
                collectReturnStatements([stmt.alternate], returns, typesModule);
            }
        } else if (
            typesModule.isForStatement(stmt) ||
            typesModule.isForInStatement(stmt) ||
            typesModule.isForOfStatement(stmt) ||
            typesModule.isWhileStatement(stmt) ||
            typesModule.isDoWhileStatement(stmt)
        ) {
            collectReturnStatements([stmt.body], returns, typesModule);
        } else if (typesModule.isSwitchStatement(stmt)) {
            for (const caseClause of stmt.cases) {
                collectReturnStatements(caseClause.consequent, returns, typesModule);
            }
        } else if (typesModule.isTryStatement(stmt)) {
            collectReturnStatements(stmt.block.body, returns, typesModule);
            if (stmt.handler) {
                collectReturnStatements(stmt.handler.body.body, returns, typesModule);
            }
            if (stmt.finalizer) {
                collectReturnStatements(stmt.finalizer.body, returns, typesModule);
            }
        } else if (typesModule.isLabeledStatement(stmt)) {
            collectReturnStatements([stmt.body], returns, typesModule);
        } else if (typesModule.isWithStatement(stmt)) {
            collectReturnStatements([stmt.body], returns, typesModule);
        }
    }
}

/**
 * Lightweight control-flow check: does this statement list guarantee a return
 * on every path? Handles direct returns and exhaustive if/else branches.
 * Conservatively returns false for loops, switch, try/catch, etc.
 */
function alwaysReturns(statements: BabelTypes.Statement[], typesModule: BabelTypesModule): boolean {
    if (statements.length === 0) {
        return false;
    }
    const last = statements[statements.length - 1];

    if (typesModule.isReturnStatement(last)) {
        return true;
    }

    if (typesModule.isIfStatement(last) && last.alternate) {
        const consequent = typesModule.isBlockStatement(last.consequent)
            ? last.consequent.body
            : [last.consequent];
        const alternate = typesModule.isBlockStatement(last.alternate)
            ? last.alternate.body
            : [last.alternate];
        return alwaysReturns(consequent, typesModule) && alwaysReturns(alternate, typesModule);
    }

    return false;
}

function getFunctionKind(node: BabelTypes.Function, typesModule: BabelTypesModule): FunctionKind {
    if (typesModule.isFunctionDeclaration(node)) {
        return 'functionDeclaration';
    }
    if (typesModule.isArrowFunctionExpression(node)) {
        return 'arrowFunction';
    }
    if (typesModule.isObjectMethod(node)) {
        return 'objectMethod';
    }
    if (typesModule.isClassPrivateMethod(node)) {
        return 'classPrivateMethod';
    }
    if (typesModule.isClassMethod(node)) {
        return 'classMethod';
    }
    return 'functionExpression';
}

function containsUnsupportedImports(code: string): boolean {
    return /['"][^'"]*(?:@css-module:|\?worker\b|\?sprite\b|dynamic!)[^'"]*['"]/.test(code);
}

export function validateSyntax(code: string, filePath: string): string | null {
    try {
        getTransformRuntime();
        parse(code, {
            sourceType: 'unambiguous',
            plugins: ['jsx', 'typescript'],
            sourceFilename: filePath,
        });
        return null;
    } catch (e: unknown) {
        return e instanceof Error ? e.message : String(e);
    }
}
