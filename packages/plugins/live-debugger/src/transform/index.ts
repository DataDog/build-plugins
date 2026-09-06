// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { ParserPlugin } from '@babel/parser';
import type _traverse from '@babel/traverse';
import type * as BabelTypes from '@babel/types';
import type MagicStringType from 'magic-string';
import type { SourceMap } from 'magic-string';

import { SKIP_INSTRUMENTATION_COMMENT } from '../constants';
import type { DecoratorSyntax, FunctionKind } from '../types';

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
        plugins: ParserPlugin[];
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
 * The name is restricted to the list of known optional peer deps so each
 * require uses a literal string (survives bundling and satisfies lint rules).
 */
function requireOptionalPeerDep<T>(name: RequiredPeerDep): T {
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

function escapeSingleQuotedJavaScriptString(value: string): string {
    return value.replace(/['\\\n\r\u2028\u2029]/g, (character) => {
        switch (character) {
            case "'":
                return "\\'";
            case '\\':
                return '\\\\';
            case '\n':
                return '\\n';
            case '\r':
                return '\\r';
            case '\u2028':
                return '\\u2028';
            case '\u2029':
                return '\\u2029';
            default:
                return character;
        }
    });
}

const HAS_FUNCTION_SYNTAX = /\bfunction\b|=>|\bclass\b|\)\s*\{/;

interface ReturnInfo {
    start: number;
    end: number;
    argStart: number | undefined;
    argEnd: number | undefined;
    hasSequenceExpressionArgument: boolean;
}

interface FunctionTarget {
    bodyStart: number;
    bodyEnd: number;
    functionEnd: number;
    isExpressionBody: boolean;
    hasSequenceExpressionBody: boolean;
    aliasesExpressionBodySuperCall: boolean;
    needsTrailingReturn: boolean;
    useThisAlias: boolean;
    bodyParenStart: number | undefined;
    directivesEnd: number | undefined;
    functionId: string;
    probeVarName: string;
    probeIdx: string;
    entryVars: string[];
    localVars: LocalVariableDeclaration[];
    returns: ReturnInfo[];
}

interface SuperCallTarget {
    start: number;
    end: number;
}

interface ConstructorThisAliasTarget {
    bodyStart: number;
    superCalls: SuperCallTarget[];
}

export interface TransformOptions {
    code: string;
    filePath: string;
    buildRoot: string;
    honorSkipComments: boolean;
    functionTypes: FunctionKind[] | undefined;
    namedOnly: boolean;
    decorators: DecoratorSyntax;
}

/**
 * Build the Babel parser plugin list. Decorators are opt-in per proposal
 * because Babel cannot enable the legacy and Stage 3 grammars simultaneously.
 */
function getParserPlugins(decorators: DecoratorSyntax): ParserPlugin[] {
    if (decorators === 'modern') {
        // TC39 Stage 3 decorators, including `accessor` auto-accessor fields.
        return ['jsx', 'typescript', 'decorators', 'decoratorAutoAccessors'];
    }

    // TypeScript's `experimentalDecorators` grammar (also allows parameter decorators).
    return ['jsx', 'typescript', 'decorators-legacy'];
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
    const { code, filePath, buildRoot, honorSkipComments, functionTypes, namedOnly, decorators } =
        options;

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
        plugins: getParserPlugins(decorators),
        sourceFilename: filePath,
    });

    // Read-only traverse: collect instrumentation targets without mutating the AST
    const targets: FunctionTarget[] = [];
    const constructorBodyStartsByNode = new Map<BabelTypes.Node, number>();
    const constructorsUsingThisAlias = new Set<BabelTypes.Node>();
    const superCallsByConstructorNode = new Map<BabelTypes.Node, SuperCallTarget[]>();
    const anonymousCountByParent = new Map<BabelTypes.Node, number>();
    let probeVarCounter = 0;

    // @babel/parser and @babel/traverse bundle separate copies of @babel/types,
    // causing a structural type mismatch. The cast is safe: parse() returns a
    // valid AST that traverse() accepts at runtime.
    traverse(ast as unknown as BabelTypes.Node, {
        Function(path: BabelPath<BabelTypes.Function>) {
            totalFunctions++;

            const derivedConstructor = getDerivedConstructor(path, babelTypes);
            if (derivedConstructor) {
                constructorBodyStartsByNode.set(derivedConstructor, derivedConstructor.body.start!);
                superCallsByConstructorNode.set(
                    derivedConstructor,
                    getSuperCallTargets(derivedConstructor.body.body, babelTypes),
                );
            }

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
                const constructorPath = getDerivedConstructorForLexicalThis(path, babelTypes);
                const useThisAlias = constructorPath != null;
                if (constructorPath) {
                    constructorsUsingThisAlias.add(constructorPath.node);
                    constructorBodyStartsByNode.set(
                        constructorPath.node,
                        constructorPath.node.body.start!,
                    );
                }

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
                    aliasesExpressionBodySuperCall:
                        useThisAlias &&
                        isExpressionBody &&
                        isSuperCallExpression(node.body, babelTypes),
                    needsTrailingReturn,
                    useThisAlias,
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
    const superCallRangesHandledByExpressionBodies =
        getSuperCallRangesHandledByExpressionBodies(targets);
    const constructorThisAliasTargets = getConstructorThisAliasTargets(
        constructorsUsingThisAlias,
        constructorBodyStartsByNode,
        superCallsByConstructorNode,
        superCallRangesHandledByExpressionBodies,
    );

    // Process inner (deeper) functions before outer ones so same-side
    // MagicString insertions at shared positions stack in the correct order.
    for (let i = targets.length - 1; i >= 0; i--) {
        injectInstrumentation(s, code, targets[i]);
    }
    for (const target of constructorThisAliasTargets) {
        injectConstructorThisAlias(s, code, target);
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
        aliasesExpressionBodySuperCall,
        useThisAlias,
        bodyParenStart,
        directivesEnd,
    } = target;

    const rvVarName = `$dd_rv${probeIdx}`;
    const receiverArg = useThisAlias ? '$dd_t' : 'this';

    const entryVarsList = entryVars.join(', ');

    const hasParams = entryVarsList !== '';

    const entryArgs = `{${entryVarsList}}`;
    const argsArg = hasParams ? `, ${entryArgs}` : '';

    const escapedFunctionId = escapeSingleQuotedJavaScriptString(functionId);
    const probeDecl = `const ${probeVarName} = $dd_probes('${escapedFunctionId}');`;
    const entryCall = `if (${probeVarName}) $dd_entry(${probeVarName}, ${receiverArg}${argsArg});`;
    const catchBlock = `catch(e) { if (${probeVarName}) $dd_throw(${probeVarName}, e, ${receiverArg}${argsArg}); throw e; }`;

    if (isExpressionBody) {
        // Arrow expression body: (a) => expr
        // Wrap in block body with temp variable to avoid duplicating nested expressions

        // Handle parenthesized expression bodies: () => ({key: value})
        // The parentheses must be removed when converting to a block body,
        // otherwise the output would be => ({block_code}) which is a syntax error.
        // Babel stores nested bodies like `((1))` as body `1`, so every wrapper
        // paren around the body range must be removed before injecting a block.
        //
        // Blank the paren with `update(..., '')` rather than `remove()`. When the
        // body is itself an instrumented function whose end abuts the closing
        // paren (e.g. `(a) => ((b) => a + b)`), that inner function has already
        // appended its instrumentation suffix to the same offset. `remove()`
        // clears the chunk's intro/outro and would drop that suffix, producing
        // invalid JavaScript; `update()` edits the content only and preserves it.
        if (bodyParenStart != null) {
            const openingParens = getLeadingArrowBodyParens(code, bodyParenStart, bodyStart);
            const closingParens = getTrailingArrowBodyParens(code, bodyEnd, functionEnd);
            const parenCount = Math.min(openingParens.length, closingParens.length);

            for (let i = 0; i < parenCount; i++) {
                const openingParen = openingParens[i];
                const closingParen = closingParens[i];
                s.update(openingParen, openingParen + 1, '');
                s.update(closingParen, closingParen + 1, '');
            }
        }

        const prefix = [
            '{',
            probeDecl,
            'try {',
            entryCall,
            aliasesExpressionBodySuperCall
                ? `const ${rvVarName} = ($dd_t = `
                : `const ${rvVarName} = `,
        ]
            .filter(Boolean)
            .join('\n');

        const returnCaptureArgs = getReturnCaptureArgs(entryArgs, hasParams, localVars, bodyEnd);
        let expressionSuffix = hasSequenceExpressionBody ? ');' : ';';
        if (aliasesExpressionBodySuperCall) {
            expressionSuffix = hasSequenceExpressionBody ? '));' : ');';
        }
        const suffix = [
            expressionSuffix,
            `if (${probeVarName}) $dd_return(${probeVarName}, ${rvVarName}, ${receiverArg}${returnCaptureArgs});`,
            `return ${rvVarName};`,
            `} ${catchBlock}`,
            '}',
        ].join('\n');

        // Anchor each injected line to the original expression's location by
        // editing the first boundary char and appending after the body. This
        // avoids overwriting nested function instrumentation when a curried
        // arrow's expression body ends at the inner function's closing brace.
        // For a single-char body (e.g. `() => 1`) the two ranges would
        // collide, so we fall back to one update covering the whole body.
        if (bodyEnd - bodyStart >= 2) {
            const bodyPrefix = hasSequenceExpressionBody
                ? `${prefix}(${code[bodyStart]}`
                : prefix + code[bodyStart];
            s.update(bodyStart, bodyStart + 1, bodyPrefix);
            s.appendRight(bodyEnd, suffix);
        } else {
            s.update(bodyStart, bodyEnd, prefix + code.slice(bodyStart, bodyEnd) + suffix);
        }
    } else {
        // Block body function
        const preamble = [probeDecl, 'try {', `let ${rvVarName};`, entryCall]
            .filter(Boolean)
            .join('\n');

        // Wrap return statements BEFORE the boundary updates so that when
        // a semicolon-free final return shares its argEnd position with
        // bodyEnd - 1, the return suffix is appended to the preceding chunk
        // (its outro) and ends up before the postamble in the generated code.
        for (const ret of returns) {
            const returnCaptureArgs = getReturnCaptureArgs(
                entryArgs,
                hasParams,
                localVars,
                ret.start,
            );

            if (ret.argStart != null && ret.argEnd != null) {
                // return EXPR; → return ($dd_rvN = EXPR, probe ? $dd_return(...) : $dd_rvN);
                const assignmentPrefix = ret.hasSequenceExpressionArgument
                    ? `(${rvVarName} = (`
                    : `(${rvVarName} = `;
                const assignmentSuffix = ret.hasSequenceExpressionArgument ? ')' : '';

                s.appendLeft(ret.argStart, assignmentPrefix);
                s.appendRight(
                    ret.argEnd,
                    `${assignmentSuffix}, ${probeVarName} ? $dd_return(${probeVarName}, ${rvVarName}, ${receiverArg}${returnCaptureArgs}) : ${rvVarName})`,
                );
            } else {
                // return; → if (probe) $dd_return(...); return;
                s.appendLeft(
                    ret.start,
                    `if (${probeVarName}) $dd_return(${probeVarName}, undefined, ${receiverArg}${returnCaptureArgs}); `,
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
            entryArgs,
            hasParams,
            localVars,
            bodyEnd,
        );
        const trailingReturn = target.needsTrailingReturn
            ? `if (${probeVarName}) $dd_return(${probeVarName}, undefined, ${receiverArg}${trailingReturnCaptureArgs});\n`
            : '';
        const postamble = `\n${trailingReturn}} ${catchBlock}\n`;
        s.update(bodyEnd - 1, bodyEnd, `${postamble}${code[bodyEnd - 1]}`);
    }
}

function injectConstructorThisAlias(
    s: MagicStringType,
    code: string,
    target: ConstructorThisAliasTarget,
): void {
    s.update(target.bodyStart, target.bodyStart + 1, `${code[target.bodyStart]}let $dd_t;`);

    for (const superCall of target.superCalls) {
        s.appendLeft(superCall.start, '($dd_t = ');
        s.appendLeft(superCall.end, ')');
    }
}

function getSuperCallTargets(
    statements: BabelTypes.Statement[],
    typesModule: BabelTypesModule,
): SuperCallTarget[] {
    const targets: SuperCallTarget[] = [];
    for (const statement of statements) {
        collectSuperCallTargetsFromNode(statement, targets, typesModule);
    }

    return targets;
}

function collectSuperCallTargetsFromNode(
    node: BabelTypes.Node,
    targets: SuperCallTarget[],
    typesModule: BabelTypesModule,
): void {
    if (isSuperCallExpression(node, typesModule)) {
        targets.push({
            start: node.start!,
            end: node.end!,
        });
    }

    const values = Object.values(node);
    for (const value of values) {
        if (Array.isArray(value)) {
            for (const item of value) {
                collectSuperCallTargetsFromUnknown(item, targets, typesModule);
            }
        } else {
            collectSuperCallTargetsFromUnknown(value, targets, typesModule);
        }
    }
}

function collectSuperCallTargetsFromUnknown(
    value: unknown,
    targets: SuperCallTarget[],
    typesModule: BabelTypesModule,
): void {
    if (!typesModule.isNode(value)) {
        return;
    }

    if (typesModule.isFunction(value) && !typesModule.isArrowFunctionExpression(value)) {
        return;
    }

    collectSuperCallTargetsFromNode(value, targets, typesModule);
}

function getConstructorThisAliasTargets(
    constructorsUsingThisAlias: Set<BabelTypes.Node>,
    constructorBodyStartsByNode: Map<BabelTypes.Node, number>,
    superCallsByConstructorNode: Map<BabelTypes.Node, SuperCallTarget[]>,
    superCallRangesHandledByExpressionBodies: Set<string>,
): ConstructorThisAliasTarget[] {
    const targets: ConstructorThisAliasTarget[] = [];

    for (const constructorNode of constructorsUsingThisAlias) {
        const bodyStart = constructorBodyStartsByNode.get(constructorNode);
        if (bodyStart == null) {
            continue;
        }

        targets.push({
            bodyStart,
            superCalls: (superCallsByConstructorNode.get(constructorNode) ?? []).filter(
                (superCall) =>
                    !superCallRangesHandledByExpressionBodies.has(getRangeKey(superCall)),
            ),
        });
    }

    return targets;
}

function getSuperCallRangesHandledByExpressionBodies(targets: FunctionTarget[]): Set<string> {
    const ranges = new Set<string>();
    for (const target of targets) {
        if (target.aliasesExpressionBodySuperCall) {
            ranges.add(getRangeKey({ start: target.bodyStart, end: target.bodyEnd }));
        }
    }

    return ranges;
}

function getRangeKey(range: SuperCallTarget): string {
    return `${range.start}:${range.end}`;
}

function getDerivedConstructor(
    path: BabelPath<BabelTypes.Function>,
    typesModule: BabelTypesModule,
): BabelTypes.ClassMethod | undefined {
    if (
        typesModule.isClassMethod(path.node) &&
        path.node.kind === 'constructor' &&
        isDerivedClassMethod(path, typesModule)
    ) {
        return path.node;
    }

    return undefined;
}

function getDerivedConstructorForLexicalThis(
    path: BabelPath,
    typesModule: BabelTypesModule,
): BabelPath<BabelTypes.ClassMethod> | undefined {
    if (typesModule.isFunction(path.node) && !typesModule.isArrowFunctionExpression(path.node)) {
        return undefined;
    }

    let current = path.parentPath;
    while (current) {
        const node = current.node;
        if (typesModule.isClassMethod(node) && node.kind === 'constructor') {
            if (!isDerivedClassMethod(current, typesModule)) {
                return undefined;
            }

            return {
                node,
                parent: current.parent,
                parentPath: current.parentPath,
            };
        }

        if (typesModule.isFunction(node)) {
            if (typesModule.isArrowFunctionExpression(node)) {
                current = current.parentPath;
                continue;
            }

            return undefined;
        }

        current = current.parentPath;
    }

    return undefined;
}

function isSuperCallExpression(
    node: BabelTypes.Node,
    typesModule: BabelTypesModule,
): node is BabelTypes.CallExpression {
    return typesModule.isCallExpression(node) && typesModule.isSuper(node.callee);
}

function isDerivedClassMethod(path: BabelPath, typesModule: BabelTypesModule): boolean {
    const classPath = path.parentPath?.parentPath;
    if (!classPath) {
        return false;
    }

    const classNode = classPath.node;
    return (
        (typesModule.isClassDeclaration(classNode) || typesModule.isClassExpression(classNode)) &&
        classNode.superClass != null
    );
}

function getReturnCaptureArgs(
    entryArgs: string,
    hasParams: boolean,
    localVars: LocalVariableDeclaration[],
    exitPosition: number,
): string {
    const localsArg = getLocalCaptureArg(localVars, exitPosition);
    if (hasParams && localsArg) {
        return `, ${entryArgs}, ${localsArg}`;
    }
    if (hasParams) {
        return `, ${entryArgs}`;
    }
    if (localsArg) {
        return `, undefined, ${localsArg}`;
    }
    return '';
}

function getLeadingArrowBodyParens(code: string, start: number, end: number): number[] {
    return collectArrowWrapperParens(code, start, end, '(');
}

function getTrailingArrowBodyParens(code: string, start: number, end: number): number[] {
    return collectArrowWrapperParens(code, start, end, ')');
}

/**
 * Collect the positions of wrapper parens around an arrow expression body.
 *
 * Only whitespace, comments, and the wrapping parens themselves can appear
 * between the outermost paren and the body (leading) or between the body and
 * the arrow's end (trailing). Comments are skipped so that parens inside a
 * comment are not mistaken for wrapper parens, which would otherwise misalign
 * removal and emit invalid JavaScript.
 *
 * Any `/` in this range necessarily starts a comment (division/regex are not
 * grammatically valid here), so no string/regex handling is required.
 */
function collectArrowWrapperParens(
    code: string,
    start: number,
    end: number,
    paren: '(' | ')',
): number[] {
    const parens: number[] = [];
    let i = start;
    while (i < end) {
        const char = code[i];
        if (char === '/') {
            const next = code[i + 1];
            if (next === '/') {
                i += 2;
                while (i < end && code[i] !== '\n') {
                    i++;
                }
                continue;
            }
            if (next === '*') {
                i += 2;
                while (i < end && !(code[i] === '*' && code[i + 1] === '/')) {
                    i++;
                }
                i += 2;
                continue;
            }
        } else if (char === paren) {
            parens.push(i);
        }
        i++;
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
                hasSequenceExpressionArgument: typesModule.isSequenceExpression(stmt.argument),
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
