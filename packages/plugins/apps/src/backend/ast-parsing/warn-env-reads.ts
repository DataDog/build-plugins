// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Logger } from '@dd/core/types';
import type * as eslintScope from 'eslint-scope';
import type {
    BaseNode,
    Expression,
    ImportSpecifier,
    ObjectPattern,
    Pattern,
    Program,
    Property,
    Super,
    VariableDeclaration,
} from 'estree';

import { NODE_BACKEND_RUNTIME } from '../../constants';

import { staticMemberName, staticPropertyName, unwrapDefaultValue } from './ambient-global-access';
import type { ModuleScopeAnalysis } from './module-scope';
import { ensureProgram } from './type-guards';
import { walkAst } from './walk-ast';

export const WHOLE_ENV_USE = 'process.env';
// Calling one of these on `process.env` runs the inherited method; any other use reads a variable of that name.
const OBJECT_PROTOTYPE_NAMES = Object.getOwnPropertyNames(Object.prototype);
const OBJECT_PROTOTYPE_KEYS = new Set(OBJECT_PROTOTYPE_NAMES);
const IDENTIFIER_KEY = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;
const PROCESS_MODULES = new Set(['process', 'node:process']);

// Every transform and local run re-checks a file, so each use is reported once per file; cleared wholesale once too large, to cap memory in long dev sessions.
export const MAX_TRACKED_FILES = 500;
export type WarnedEnvReads = Map<string, Set<string>>;

export const ENV_NOT_PASSED_EXPLANATION = `In production, the ${NODE_BACKEND_RUNTIME} doesn't pass your own environment variables or Custom Credentials to backend functions, so these reads won't see your values there.`;

type Role = 'process' | 'env';
// Recorded beside a file's reported uses, so a failed check warns once per file too.
const CHECK_FAILED = '\0check failed';

function isProcessImport(statement: Program['body'][number]): boolean {
    return (
        statement.type === 'ImportDeclaration' &&
        PROCESS_MODULES.has(String(statement.source.value))
    );
}

function mentionsProcess(program: Program, scope: ModuleScopeAnalysis): boolean {
    for (const [identifier, reference] of scope.referencesByIdentifier) {
        if (!reference.resolved && identifier.name === 'process') {
            return true;
        }
    }
    return program.body.some(isProcessImport);
}

function importedName(specifier: ImportSpecifier): string {
    const { imported } = specifier;
    return imported.type === 'Identifier' ? imported.name : String(imported.value);
}

function unwrapChain(node: Expression | Super): Expression | Super {
    return node.type === 'ChainExpression' ? node.expression : node;
}

// `process.env ?? {}` and `process.env || {}` evaluate to the real env whenever it exists.
function unwrapFallback(node: Expression | Super): Expression | Super {
    const unwrapped = unwrapChain(node);
    const isFallback = unwrapped.type === 'LogicalExpression' && unwrapped.operator !== '&&';
    return isFallback ? unwrapFallback(unwrapped.left) : unwrapped;
}

function envUse(key: string): string {
    return IDENTIFIER_KEY.test(key) ? `process.env.${key}` : `process.env[${JSON.stringify(key)}]`;
}

// Only direct forms: `process` (global or imported), `process.env`, an imported `env`, and a `const`
// bound to `process.env` or to an `env` destructured from `process`.
function createEnvMatcher(program: Program, scope: ModuleScopeAnalysis) {
    const roles = new Map<eslintScope.Variable, Role>();
    const roleOf = (node: Expression | Super): Role | undefined => {
        const reference = node.type === 'Identifier' && scope.referencesByIdentifier.get(node);
        if (!reference) {
            return undefined;
        }
        if (!reference.resolved) {
            return reference.identifier.name === 'process' ? 'process' : undefined;
        }
        return roles.get(reference.resolved);
    };
    const isDirectEnv = (expression: Expression | Super): boolean => {
        const node = unwrapFallback(expression);
        return (
            node.type === 'MemberExpression' &&
            staticMemberName(node, scope) === 'env' &&
            roleOf(node.object) === 'process'
        );
    };

    for (const statement of program.body) {
        if (statement.type !== 'ImportDeclaration' || !isProcessImport(statement)) {
            continue;
        }
        for (const specifier of statement.specifiers) {
            const [variable] = scope.scopeManager.getDeclaredVariables(specifier);
            const name = specifier.type === 'ImportSpecifier' ? importedName(specifier) : undefined;
            const isEnvImport = name === 'env';
            const isProcessObjectImport =
                specifier.type !== 'ImportSpecifier' || name === 'default';
            if (variable && isProcessObjectImport) {
                roles.set(variable, 'process');
            } else if (variable && isEnvImport) {
                roles.set(variable, 'env');
            }
        }
    }

    // A `const` binding's declaration is its only write, which eslint-scope records as a reference.
    const markEnvBinding = (binding: Property['value']) => {
        const reference =
            binding.type === 'Identifier' && scope.referencesByIdentifier.get(binding);
        if (reference && reference.resolved) {
            roles.set(reference.resolved, 'env');
        }
    };
    walkAst(program, null, {
        VariableDeclaration(node) {
            if (node.kind !== 'const') {
                return;
            }
            for (const { id, init } of node.declarations) {
                if (init && isDirectEnv(init)) {
                    markEnvBinding(id);
                }
                if (!init || id.type !== 'ObjectPattern' || roleOf(init) !== 'process') {
                    continue;
                }
                for (const property of id.properties) {
                    const key = property.type === 'Property' && staticPropertyName(property, scope);
                    if (property.type === 'Property' && key === 'env') {
                        const binding = unwrapDefaultValue(property.value);
                        markEnvBinding(binding);
                    }
                }
            }
        },
    });

    return {
        isEnv: (node: Expression | Super): boolean =>
            isDirectEnv(node) || roleOf(unwrapFallback(node)) === 'env',
        isProcess: (node: Expression | Super): boolean =>
            roleOf(unwrapFallback(node)) === 'process',
    };
}

// Warns (never rejects) on `process.env` reads, since production doesn't pass the developer's variables or Custom Credentials.
export function warnAboutEnvReads(
    ast: BaseNode,
    filePath: string,
    log: Logger,
    scopeAnalysis: ModuleScopeAnalysis,
    warnedEnvReads: WarnedEnvReads,
): void {
    const program = ensureProgram(ast, filePath);
    const uses = new Set<string>();
    const addKey = (key: string | undefined) => {
        uses.add(key === undefined ? WHOLE_ENV_USE : envUse(key));
    };
    if (!mentionsProcess(program, scopeAnalysis)) {
        return;
    }
    try {
        const { isEnv, isProcess } = createEnvMatcher(program, scopeAnalysis);
        const writtenMembers = new Set<BaseNode>();
        const calledMembers = new Set<BaseNode>();
        const markWriteTargets = (target: Pattern) => {
            if (target.type === 'MemberExpression') {
                writtenMembers.add(target);
            } else if (target.type === 'ArrayPattern') {
                for (const element of target.elements) {
                    if (element) {
                        markWriteTargets(element);
                    }
                }
            } else if (target.type === 'ObjectPattern') {
                for (const property of target.properties) {
                    markWriteTargets(property.type === 'RestElement' ? property : property.value);
                }
            } else if (target.type === 'AssignmentPattern') {
                markWriteTargets(target.left);
            } else if (target.type === 'RestElement') {
                markWriteTargets(target.argument);
            }
        };
        const markLoopTarget = (left: Pattern | VariableDeclaration) => {
            if (left.type !== 'VariableDeclaration') {
                markWriteTargets(left);
            }
        };
        const addDestructuredKeys = (pattern: ObjectPattern) => {
            for (const property of pattern.properties) {
                const key =
                    property.type === 'RestElement'
                        ? undefined
                        : staticPropertyName(property, scopeAnalysis);
                addKey(key);
            }
        };
        const checkDestructure = (pattern: ObjectPattern, init: Expression) => {
            if (isEnv(init)) {
                addDestructuredKeys(pattern);
                return;
            }
            if (!isProcess(init)) {
                return;
            }
            for (const property of pattern.properties) {
                const isEnvProperty =
                    property.type === 'Property' &&
                    staticPropertyName(property, scopeAnalysis) === 'env';
                const value = isEnvProperty && unwrapDefaultValue(property.value);
                if (value && value.type === 'ObjectPattern') {
                    addDestructuredKeys(value);
                }
            }
        };
        walkAst(program, null, {
            CallExpression(node) {
                calledMembers.add(unwrapChain(node.callee));
            },
            AssignmentExpression(node) {
                if (node.operator === '=') {
                    markWriteTargets(node.left);
                }
                if (node.left.type === 'ObjectPattern') {
                    checkDestructure(node.left, node.right);
                }
            },
            AssignmentPattern(node) {
                if (node.left.type === 'ObjectPattern') {
                    checkDestructure(node.left, node.right);
                }
            },
            ForInStatement(node) {
                markLoopTarget(node.left);
            },
            ForOfStatement(node) {
                markLoopTarget(node.left);
            },
            UnaryExpression(node) {
                if (node.operator === 'delete') {
                    writtenMembers.add(unwrapChain(node.argument));
                }
            },
            VariableDeclarator(node) {
                if (node.id.type === 'ObjectPattern' && node.init) {
                    checkDestructure(node.id, node.init);
                }
            },
            MemberExpression(node) {
                if (writtenMembers.has(node) || !isEnv(node.object)) {
                    return;
                }
                const key = staticMemberName(node, scopeAnalysis);
                const isInheritedMethodCall =
                    calledMembers.has(node) && key !== undefined && OBJECT_PROTOTYPE_KEYS.has(key);
                if (!isInheritedMethodCall) {
                    addKey(key);
                }
            },
        });
    } catch (error) {
        // A warning-only check must not fail the build.
        const warned = warnedUsesFor(warnedEnvReads, filePath);
        if (!warned.has(CHECK_FAILED)) {
            warned.add(CHECK_FAILED);
            const reason = error instanceof Error ? error.message : String(error);
            log.warn(`Could not check ${filePath} for process.env reads: ${reason}`);
        }
    }
    reportNewUses(uses, filePath, log, warnedEnvReads);
}

function warnedUsesFor(warnedEnvReads: WarnedEnvReads, filePath: string): Set<string> {
    let warned = warnedEnvReads.get(filePath);
    if (!warned) {
        if (warnedEnvReads.size >= MAX_TRACKED_FILES) {
            warnedEnvReads.clear();
        }
        warned = new Set<string>();
        warnedEnvReads.set(filePath, warned);
    }
    return warned;
}

function reportNewUses(
    uses: ReadonlySet<string>,
    filePath: string,
    log: Logger,
    warnedEnvReads: WarnedEnvReads,
): void {
    if (uses.size === 0) {
        return;
    }
    const warned = warnedUsesFor(warnedEnvReads, filePath);
    const newUses = [...uses].filter((use) => !warned.has(use));
    if (newUses.length === 0) {
        return;
    }
    for (const use of newUses) {
        warned.add(use);
    }
    const useList = newUses.join(', ');
    log.warn(`${filePath} uses ${useList}. ${ENV_NOT_PASSED_EXPLANATION}`);
}
