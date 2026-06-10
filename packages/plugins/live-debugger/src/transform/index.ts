// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type _traverse from '@babel/traverse';
import type * as BabelTypes from '@babel/types';
import type MagicStringType from 'magic-string';
import type { SourceMap } from 'magic-string';

import { SKIP_INSTRUMENTATION_COMMENT } from '../constants';
import type { FunctionKind } from '../types';

import type { BabelPath, BabelTypesModule } from './babel-path.types';
import { resolveCjsDefaultExport } from './cjs-interop';
import { generateFunctionId, getFunctionName } from './functionId';
import { canInstrumentFunction, shouldSkipFunction } from './instrumentation';
import { getLocalVariableDeclarations, getParameterNames } from './scopeTracker';
import type { LocalVariableDeclaration } from './scopeTracker';

type TraverseFn = typeof _traverse;
type ParseFn = (
    code: string,
    options: {
        sourceType: 'unambiguous';
        plugins: string[];
        sourceFilename: string;
    },
) => BabelTypes.File;
type MagicStringConstructor = typeof import('magic-string').default;

/**
 * Optional peer dependencies that must be present at runtime for the
 * Live Debugger transform to work. They are declared as optional peer
 * dependencies on the published packages so users who don't enable the
 * plugin don't have to install them.
 */
const REQUIRED_PEER_DEPS = [
    '@babel/parser',
    '@babel/traverse',
    '@babel/types',
    'magic-string',
] as const;
type RequiredPeerDep = (typeof REQUIRED_PEER_DEPS)[number];

// Node attaches a string `code` to filesystem/module resolution errors.
type NodeModuleError = Error & { code?: string };

let hasLoadedTransformRuntime = false;
let parse: ParseFn;
let traverse: TraverseFn;
let babelTypes: BabelTypesModule;
let MagicString: MagicStringConstructor;

const getTransformRuntime = (): void => {
    if (!hasLoadedTransformRuntime) {
        // Lazy-load heavy peer deps only when we actually instrument a file.
        // `require()` (not `import()`) because the transform hook is synchronous.
        // `requireOptionalPeerDep` rewrites `MODULE_NOT_FOUND` into a message
        // pointing users at the install step.
        parse = requireOptionalPeerDep<{ parse: ParseFn }>('@babel/parser').parse;
        traverse = resolveCjsDefaultExport(
            requireOptionalPeerDep<TraverseFn | { default: TraverseFn }>('@babel/traverse'),
        );
        babelTypes = requireOptionalPeerDep<BabelTypesModule>('@babel/types');
        MagicString = resolveCjsDefaultExport(
            requireOptionalPeerDep<MagicStringConstructor | { default: MagicStringConstructor }>(
                'magic-string',
            ),
        );

        hasLoadedTransformRuntime = true;
    }
};

/**
 * Wrapper around `require()` that turns `MODULE_NOT_FOUND` into a clear,
 * actionable error pointing at our optional peer dependencies.
 *
 * Exported so tests can exercise the error path directly; the name is
 * restricted to the list of known optional peer deps so each require
 * uses a literal string (survives bundling and satisfies lint rules).
 */
export function requireOptionalPeerDep<T>(name: RequiredPeerDep): T {
    try {
        return loadKnownPeerDep(name) as T;
    } catch (error) {
        throw rewrapMissingPeerDepError(error);
    }
}

function loadKnownPeerDep(name: RequiredPeerDep): unknown {
    switch (name) {
        case '@babel/parser':
            // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
            return require('@babel/parser');
        case '@babel/traverse':
            // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
            return require('@babel/traverse');
        case '@babel/types':
            // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
            return require('@babel/types');
        case 'magic-string':
            // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
            return require('magic-string');
        default: {
            const exhaustive: never = name;
            throw new Error(`Unknown peer dependency: ${exhaustive as string}`);
        }
    }
}

function rewrapMissingPeerDepError(error: unknown): Error {
    if (!isMissingPeerDepError(error)) {
        return error instanceof Error ? error : new Error(String(error));
    }
    const missingDep = REQUIRED_PEER_DEPS.find((dep) => error.message.includes(dep));
    const target = missingDep ?? REQUIRED_PEER_DEPS.join(', ');
    return new Error(
        `Datadog Live Debugger could not load "${target}". ` +
            `It is an optional peer dependency that must be installed in your project ` +
            `when the \`liveDebugger\` plugin is enabled. Install the peer dependencies with: ` +
            `\`npm install --save-dev ${REQUIRED_PEER_DEPS.join(' ')}\` ` +
            `(or the yarn/pnpm/bun equivalent). ` +
            `Underlying error: ${error.message}`,
    );
}

function isMissingPeerDepError(error: unknown): error is NodeModuleError {
    if (!(error instanceof Error)) {
        return false;
    }
    const code = (error as NodeModuleError).code;
    if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') {
        return false;
    }
    return REQUIRED_PEER_DEPS.some((dep) => error.message.includes(dep));
}

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
    hasSequenceExpressionBody: boolean;
    needsTrailingReturn: boolean;
    bodyParenStart: number | undefined;
    directivesEnd: number | undefined;
    functionId: string;
    probeVarName: string;
    probeIdx: string;
    entryVars: string[];
    localVars: LocalVariableDeclaration[];
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

            if (!canInstrumentFunction(path, babelTypes)) {
                skippedUnsupportedCount++;
                return;
            }

            if (
                honorSkipComments &&
                shouldSkipFunction(path, SKIP_INSTRUMENTATION_COMMENT, babelTypes)
            ) {
                skippedByCommentCount++;
                return;
            }

            if (functionTypes && !functionTypes.includes(getFunctionKind(path.node, babelTypes))) {
                skippedUnsupportedCount++;
                return;
            }

            if (namedOnly && !getFunctionName(path, babelTypes)) {
                skippedUnsupportedCount++;
                return;
            }

            // O(1) anonymous sibling index via pre-indexed Map
            let anonymousSiblingIndex = 0;
            if (!getFunctionName(path, babelTypes)) {
                const parentNode = path.parentPath?.node;
                if (parentNode) {
                    anonymousSiblingIndex = anonymousCountByParent.get(parentNode) || 0;
                    anonymousCountByParent.set(parentNode, anonymousSiblingIndex + 1);
                }
            }

            const functionId = generateFunctionId(
                filePath,
                buildRoot,
                path,
                anonymousSiblingIndex,
                babelTypes,
            );

            try {
                const node = path.node;
                const idx = probeVarCounter++;
                const probeVarName = `$dd_p${idx}`;
                const entryVars = getParameterNames(node, babelTypes);
                const localVars = getLocalVariableDeclarations(node, babelTypes);

                const isExpressionBody =
                    babelTypes.isArrowFunctionExpression(node) &&
                    !babelTypes.isBlockStatement(node.body);
                const hasSequenceExpressionBody =
                    isExpressionBody && babelTypes.isSequenceExpression(node.body);

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
                    hasSequenceExpressionBody,
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
                    localVars,
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
        map: s.generateMap({ source: filePath, hires: true }),
        failedCount,
        instrumentedCount,
        skippedByCommentCount,
        skippedFileCount: 0,
        skippedUnsupportedCount,
        totalFunctions,
    };
}

/**
 * Inject instrumentation for a single function.
 */
function injectInstrumentation(s: MagicStringType, code: string, target: FunctionTarget): void {
    const {
        probeVarName,
        probeIdx,
        functionId,
        entryVars,
        localVars,
        returns,
        bodyStart,
        bodyEnd,
        functionEnd,
        isExpressionBody,
        hasSequenceExpressionBody,
        bodyParenStart,
        directivesEnd,
    } = target;

    const entryHelper = `$dd_e${probeIdx}`;
    const rvVarName = `$dd_rv${probeIdx}`;

    const entryVarsList = entryVars.join(', ');

    const hasParams = entryVarsList !== '';

    const argsArg = hasParams ? `, ${entryHelper}()` : '';

    // TODO: functionId is not escaped — if it contains a single quote (e.g. quoted method names),
    // the generated code will be invalid. Escaping is not currently supported.
    const probeDecl = `const ${probeVarName} = $dd_probes('${functionId}');`;
    const entryHelperDecl = hasParams ? `const ${entryHelper} = () => ({${entryVarsList}});` : '';
    const entryCall = `if (${probeVarName}) $dd_entry(${probeVarName}, this${argsArg});`;
    const catchBlock = `catch(e) { if (${probeVarName}) $dd_throw(${probeVarName}, e, this${argsArg}); throw e; }`;

    if (isExpressionBody) {
        // Arrow expression body: (a) => expr
        // Wrap in block body with temp variable to avoid duplicating nested expressions

        // Handle parenthesized expression bodies: () => ({key: value})
        // The parentheses must be removed when converting to a block body,
        // otherwise the output would be => ({block_code}) which is a syntax error.
        // Babel stores nested bodies like `((1))` as body `1`, so every wrapper
        // paren around the body range must be removed before injecting a block.
        if (bodyParenStart != null) {
            const openingParens = getLeadingArrowBodyParens(code, bodyParenStart, bodyStart);
            const closingParens = getTrailingArrowBodyParens(code, bodyEnd, functionEnd);
            const parenCount = Math.min(openingParens.length, closingParens.length);

            for (let i = 0; i < parenCount; i++) {
                const openingParen = openingParens[i];
                const closingParen = closingParens[i];
                s.remove(openingParen, openingParen + 1);
                s.remove(closingParen, closingParen + 1);
            }
        }

        const prefix = [
            '{',
            probeDecl,
            entryHelperDecl,
            'try {',
            entryCall,
            `const ${rvVarName} = `,
        ]
            .filter(Boolean)
            .join('\n');

        const returnCaptureArgs = getReturnCaptureArgs(entryHelper, hasParams, localVars, bodyEnd);
        const expressionSuffix = hasSequenceExpressionBody ? ');' : ';';
        const suffix = [
            expressionSuffix,
            `if (${probeVarName}) $dd_return(${probeVarName}, ${rvVarName}, this${returnCaptureArgs});`,
            `return ${rvVarName};`,
            `} ${catchBlock}`,
            '}',
        ].join('\n');

        // Anchor each injected line to the original expression's location by
        // editing the boundary chars of the body. Two updates avoid losing
        // per-character mappings of the original expression in between.
        // For a single-char body (e.g. `() => 1`) the two ranges would
        // collide, so we fall back to one update covering the whole body.
        if (bodyEnd - bodyStart >= 2) {
            const bodyPrefix = hasSequenceExpressionBody
                ? `${prefix}(${code[bodyStart]}`
                : prefix + code[bodyStart];
            s.update(bodyStart, bodyStart + 1, bodyPrefix);
            s.update(bodyEnd - 1, bodyEnd, code[bodyEnd - 1] + suffix);
        } else {
            s.update(bodyStart, bodyEnd, prefix + code.slice(bodyStart, bodyEnd) + suffix);
        }
    } else {
        // Block body function
        const preamble = [probeDecl, entryHelperDecl, 'try {', `let ${rvVarName};`, entryCall]
            .filter(Boolean)
            .join('\n');

        // Wrap return statements BEFORE the boundary updates so that when
        // a semicolon-free final return shares its argEnd position with
        // bodyEnd - 1, the return suffix is appended to the preceding chunk
        // (its outro) and ends up before the postamble in the generated code.
        for (const ret of returns) {
            const returnCaptureArgs = getReturnCaptureArgs(
                entryHelper,
                hasParams,
                localVars,
                ret.start,
            );

            if (ret.argStart != null && ret.argEnd != null) {
                // return EXPR; → return ($dd_rvN = EXPR, probe ? $dd_return(...) : $dd_rvN);
                s.appendLeft(ret.argStart, `(${rvVarName} = `);
                s.appendLeft(
                    ret.argEnd,
                    `, ${probeVarName} ? $dd_return(${probeVarName}, ${rvVarName}, this${returnCaptureArgs}) : ${rvVarName})`,
                );
            } else {
                // return; → if (probe) $dd_return(...); return;
                s.appendLeft(
                    ret.start,
                    `if (${probeVarName}) $dd_return(${probeVarName}, undefined, this${returnCaptureArgs}); `,
                );
            }
        }

        // Wrap the boundary character (last directive char or the body's
        // opening `{`) with `<char><preamble>`. Editing through `update()`
        // makes magic-string emit a source-map segment for every line of
        // the new content, all anchored at that boundary char's location —
        // so injected preamble lines map to the function's own line instead
        // of to nothing.
        //
        // For directives, an additional leading newline keeps the preamble
        // on its own line (the directive's trailing `;` already ends a
        // statement, but its terminator stays on the directive's line).
        if (directivesEnd != null) {
            const anchor = directivesEnd - 1;
            s.update(anchor, directivesEnd, `${code[anchor]}\n${preamble}`);
        } else {
            s.update(bodyStart, bodyStart + 1, `${code[bodyStart]}${preamble}`);
        }

        // Build the postamble. The optional trailing-return helper is
        // included here (rather than as a separate appendLeft) so that the
        // single boundary update for `}` covers it; this keeps the trailing
        // helper's source-map segment anchored to the closing brace too.
        const trailingReturnCaptureArgs = getReturnCaptureArgs(
            entryHelper,
            hasParams,
            localVars,
            bodyEnd,
        );
        const trailingReturn = target.needsTrailingReturn
            ? `if (${probeVarName}) $dd_return(${probeVarName}, undefined, this${trailingReturnCaptureArgs});\n`
            : '';
        const postamble = `\n${trailingReturn}} ${catchBlock}\n`;
        s.update(bodyEnd - 1, bodyEnd, `${postamble}${code[bodyEnd - 1]}`);
    }
}

function getReturnCaptureArgs(
    entryHelper: string,
    hasParams: boolean,
    localVars: LocalVariableDeclaration[],
    exitPosition: number,
): string {
    const localsArg = getLocalCaptureArg(localVars, exitPosition);
    if (hasParams && localsArg) {
        return `, ${entryHelper}(), ${localsArg}`;
    }
    if (hasParams) {
        return `, ${entryHelper}()`;
    }
    if (localsArg) {
        return `, undefined, ${localsArg}`;
    }
    return '';
}

function getLeadingArrowBodyParens(code: string, start: number, end: number): number[] {
    const parens: number[] = [];
    for (let i = start; i < end; i++) {
        if (code[i] === '(') {
            parens.push(i);
        }
    }
    return parens;
}

function getTrailingArrowBodyParens(code: string, start: number, end: number): number[] {
    const parens: number[] = [];
    for (let i = end - 1; i >= start; i--) {
        if (code[i] === ')') {
            parens.push(i);
        }
    }
    return parens;
}

function getLocalCaptureArg(
    localVars: LocalVariableDeclaration[],
    exitPosition: number,
): string | undefined {
    const availableLocals = localVars
        .filter(
            ({ declarationEnd, temporalDeadZones }) =>
                declarationEnd <= exitPosition &&
                !isInTemporalDeadZone(temporalDeadZones, exitPosition),
        )
        .map(({ name }) => name);

    if (availableLocals.length === 0) {
        return undefined;
    }

    return `{${availableLocals.join(', ')}}`;
}

function isInTemporalDeadZone(
    temporalDeadZones: LocalVariableDeclaration['temporalDeadZones'],
    position: number,
): boolean {
    return temporalDeadZones.some(({ start, end }) => start <= position && position < end);
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
