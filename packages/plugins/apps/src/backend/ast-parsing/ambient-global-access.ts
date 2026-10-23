// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type * as eslintScope from 'eslint-scope';
import type {
    BaseNode,
    Node as EstreeNode,
    Expression,
    Identifier,
    MemberExpression,
    ObjectPattern,
    PrivateIdentifier,
    Program,
    Property,
    Super,
    VariableDeclarator,
} from 'estree';

import { resolveIdentifier } from './module-scope';
import type { ModuleScopeAnalysis } from './module-scope';
import { isVariableDeclaratorNode, staticStringValue } from './type-guards';
import { parentsOf, walkAst } from './walk-ast';

const GLOBAL_THIS_NAME = 'globalThis';
const NODE_GLOBAL_ALIAS_NAME = 'global';

// `global` is Node's own alias for the ambient global object.
function isAmbientGlobalReceiverName(name: string): boolean {
    return name === GLOBAL_THIS_NAME || name === NODE_GLOBAL_ALIAS_NAME;
}

// Tracks a for-of loop's ambient-global binding (see the ForOfStatement visitor below) — a loop variable has no `.init` for resolvesToAmbientGlobal's normal alias-chain check to inspect. Reset per forEachAmbientGlobalAccess call.
let forOfAmbientAliases = new Set<eslintScope.Variable>();

// Only an unresolved `globalThis`/`global` identifier or a chain of single-`const` aliases counts — a `let`, parameter, or other ambiguous binding is treated as opaque.
function resolvesToAmbientGlobal(
    node: Expression | Super,
    scopeAnalysis: ModuleScopeAnalysis,
    visited: Set<eslintScope.Variable> = new Set(),
): boolean {
    // `globalThis.globalThis`/`global.global` is a real self-reference — recurse through it before treating other receiver shapes as opaque.
    if (node.type === 'MemberExpression') {
        const propertyName = staticMemberName(node, scopeAnalysis);
        if (!propertyName || !isAmbientGlobalReceiverName(propertyName)) {
            return false;
        }
        return resolvesToAmbientGlobal(node.object, scopeAnalysis, visited);
    }

    if (node.type !== 'Identifier') {
        return false;
    }

    const variable = resolveIdentifier(node, scopeAnalysis);
    if (!variable) {
        return isAmbientGlobalReceiverName(node.name);
    }

    if (forOfAmbientAliases.has(variable)) {
        return true;
    }

    if (visited.has(variable) || variable.defs.length !== 1) {
        return false;
    }
    visited.add(variable);

    const [definition] = variable.defs;
    if (definition.type !== 'Variable' || definition.parent.kind !== 'const') {
        return false;
    }

    // `definition.node` is typed against eslint-scope's bundled (structurally identical) `estree` types — narrowed via a type guard rather than asserted.
    if (!isVariableDeclaratorNode(definition.node)) {
        return false;
    }
    const { id, init } = definition.node;
    if (!init) {
        return false;
    }

    if (id.type === 'Identifier') {
        return resolvesToAmbientGlobal(init, scopeAnalysis, visited);
    }
    // A destructure normally names a property of `y`, not `y` itself — unless every key on the
    // path down to this binding is a `globalThis`/`global` self-reference (`const { globalThis:
    // { globalThis: g } } = globalThis`), since `y.globalThis === y` holds at any depth of
    // repeated self-reference, not just one level.
    if (id.type === 'ObjectPattern') {
        const reachesSelfReference = (pattern: ObjectPattern): boolean =>
            pattern.properties.some((property) => {
                if (property.type !== 'Property') {
                    return false;
                }
                const propertyName = staticPropertyName(property, scopeAnalysis) ?? '';
                if (!isAmbientGlobalReceiverName(propertyName)) {
                    return false;
                }
                const value = unwrapDefaultValue(property.value);
                return (
                    value === definition.name ||
                    (value.type === 'ObjectPattern' && reachesSelfReference(value))
                );
            });
        if (reachesSelfReference(id)) {
            return resolvesToAmbientGlobal(init, scopeAnalysis, visited);
        }
    }

    return false;
}

export function staticMemberName(
    node: MemberExpression,
    scopeAnalysis: ModuleScopeAnalysis,
): string | undefined {
    if (!node.computed) {
        return node.property.type === 'Identifier' ? node.property.name : undefined;
    }
    return resolveStaticPropertyName(node.property, scopeAnalysis);
}

// A defaulted property value (`{ x = fallback }`) is an AssignmentPattern wrapping the real binding — unwrap it so a defaulted alias is treated the same as a bare one.
export function unwrapDefaultValue(value: Property['value']): Property['value'] {
    return value.type === 'AssignmentPattern' ? value.left : value;
}

export function staticPropertyName(
    property: Property,
    scopeAnalysis: ModuleScopeAnalysis,
): string | undefined {
    // A non-computed key can still be a quoted string literal (`{ 'fetch': f }`) — fall through to resolveStaticPropertyName for that shape.
    if (!property.computed && property.key.type === 'Identifier') {
        return property.key.name;
    }
    return resolveStaticPropertyName(property.key, scopeAnalysis);
}

// A computed key (`globalThis[f]`, `const { [key]: r } = globalThis`) is just as knowable as a
// literal when it traces back to one through a chain of `const` aliases — the same reasoning
// resolvesToAmbientGlobal applies to the object side of a member expression applies here to the
// property side, since neither shape evaluates anything dynamic. `visited` is independent of
// resolvesToAmbientGlobal's own set: it walks a different alias chain (the key's value, not the
// receiver object), and guards the same way against a self-referential `const` cycle hanging the
// linter instead of just failing to resolve.
function resolveStaticPropertyName(
    node: Expression | PrivateIdentifier,
    scopeAnalysis: ModuleScopeAnalysis,
    visited: Set<eslintScope.Variable> = new Set(),
): string | undefined {
    const direct = staticStringValue(node);
    if (direct !== undefined) {
        return direct;
    }
    if (node.type !== 'Identifier') {
        return undefined;
    }

    const variable = resolveIdentifier(node, scopeAnalysis);
    if (!variable || visited.has(variable) || variable.defs.length !== 1) {
        return undefined;
    }
    visited.add(variable);

    const [definition] = variable.defs;
    if (definition.type !== 'Variable' || definition.parent.kind !== 'const') {
        return undefined;
    }
    if (!isVariableDeclaratorNode(definition.node)) {
        return undefined;
    }
    const { id, init } = definition.node;
    if (id.type !== 'Identifier' || !init) {
        return undefined;
    }
    return resolveStaticPropertyName(init, scopeAnalysis, visited);
}

// A for-of binding identifier is a declaration site, not a reference, so `resolveIdentifier` (which only resolves references) can't find it — look it up via eslint-scope's declarator-to-Variable index instead.
function findDeclaredVariable(
    declarator: VariableDeclarator,
    scopeAnalysis: ModuleScopeAnalysis,
): eslintScope.Variable | undefined {
    return scopeAnalysis.scopeManager.getDeclaredVariables(declarator)[0];
}

export interface AmbientGlobalAccessHandlers {
    /** A watched name was reached where its absence throws. */
    onNamedAccess(name: string): void;
}

function isPattern(node: BaseNode): boolean {
    return node.type === 'ObjectPattern' || node.type === 'ArrayPattern';
}

// A missing global reads as undefined, which throws once it's used as an object, function or class.
// A `?.` earlier in the same chain short-circuits the rest of it.
function throwsWhenUndefined(
    node: BaseNode,
    parentOf: (node: BaseNode) => EstreeNode | undefined,
): boolean {
    let current = node;
    let shortCircuited = false;
    for (let parent = parentOf(current); parent; parent = parentOf(current)) {
        if (
            (parent.type === 'MemberExpression' && parent.object === current) ||
            (parent.type === 'CallExpression' && parent.callee === current)
        ) {
            shortCircuited ||= parent.optional;
            if (!shortCircuited) {
                return true;
            }
        } else if (parent.type === 'ChainExpression') {
            shortCircuited = false;
        } else {
            return (
                (parent.type === 'NewExpression' && parent.callee === current) ||
                (parent.type === 'TaggedTemplateExpression' && parent.tag === current) ||
                ((parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') &&
                    parent.superClass === current) ||
                (parent.type === 'BinaryExpression' &&
                    parent.right === current &&
                    (parent.operator === 'instanceof' || parent.operator === 'in')) ||
                (parent.type === 'ForOfStatement' && parent.right === current) ||
                (parent.type === 'SpreadElement' &&
                    parentOf(parent)?.type !== 'ObjectExpression') ||
                (parent.type === 'VariableDeclarator' &&
                    parent.init === current &&
                    isPattern(parent.id)) ||
                (parent.type === 'AssignmentExpression' &&
                    parent.right === current &&
                    isPattern(parent.left))
            );
        }
        current = parent;
    }
    return false;
}

// Reports watched names reached on the ambient global object, by name or through an alias, where their
// absence throws; bulk copies such as `{ ...globalThis }` aren't followed.
export function forEachAmbientGlobalAccess(
    program: Program,
    scopeAnalysis: ModuleScopeAnalysis,
    names: ReadonlySet<string>,
    handlers: AmbientGlobalAccessHandlers,
): void {
    forOfAmbientAliases = new Set();
    let parentMap: Map<BaseNode, EstreeNode> | undefined;
    const parentOf = (node: BaseNode) => {
        parentMap ??= parentsOf(program);
        return parentMap.get(node);
    };
    const followedBindings = new Set<eslintScope.Variable>();

    // A binding written only here holds the missing global, so it throws wherever the global would have.
    const bindingThrows = (binding: Identifier): boolean => {
        const variable = scopeAnalysis.referencesByIdentifier.get(binding)?.resolved;
        if (!variable || followedBindings.has(variable)) {
            return false;
        }
        followedBindings.add(variable);
        const { references } = variable;
        return (
            references.every(
                (reference) => !reference.isWrite() || reference.identifier === binding,
            ) &&
            references.some((reference) => reference.isRead() && reachThrows(reference.identifier))
        );
    };

    const reachThrows = (node: BaseNode): boolean => {
        const parent = parentOf(node);
        if (
            parent?.type === 'VariableDeclarator' &&
            parent.init === node &&
            parent.id.type === 'Identifier'
        ) {
            return bindingThrows(parent.id);
        }
        return throwsWhenUndefined(node, parentOf);
    };

    // An undeclared bare name throws a ReferenceError on any use but `typeof`.
    for (const [identifier, reference] of scopeAnalysis.referencesByIdentifier) {
        if (!names.has(identifier.name) || reference.resolved) {
            continue;
        }
        const parent = parentOf(identifier);
        if (parent?.type !== 'UnaryExpression' || parent.operator !== 'typeof') {
            handlers.onNamedAccess(identifier.name);
        }
    }

    // Shared by both `const { x } = globalThis`-style destructures and a for-of loop's inline destructure below — the per-property checking is identical once the source is known to be the ambient global.
    const checkDestructuredPattern = (pattern: ObjectPattern) => {
        for (const property of pattern.properties) {
            if (property.type === 'RestElement') {
                continue;
            }
            const name = staticPropertyName(property, scopeAnalysis);
            const { value } = property;
            // A default (`{ EventSource = P }`) fills the gap; a nested pattern destructures undefined.
            const isWatched = !!name && names.has(name);
            if (
                isWatched &&
                (value.type === 'Identifier' ? bindingThrows(value) : isPattern(value))
            ) {
                handlers.onNamedAccess(name);
            }
            // `const { globalThis: { fetch } } = globalThis` is a real self-reference, so recurse the same way resolvesToAmbientGlobal's MemberExpression case does — otherwise a name nested inside a `globalThis`/`global` key escapes detection.
            const nestedPattern = unwrapDefaultValue(value);
            if (
                name &&
                isAmbientGlobalReceiverName(name) &&
                nestedPattern.type === 'ObjectPattern'
            ) {
                checkDestructuredPattern(nestedPattern);
            }
        }
    };

    const checkDestructure = (pattern: ObjectPattern, init: Expression | null | undefined) => {
        if (!init || !resolvesToAmbientGlobal(init, scopeAnalysis)) {
            return;
        }
        checkDestructuredPattern(pattern);
    };

    walkAst(program, null, {
        MemberExpression(node) {
            if (!resolvesToAmbientGlobal(node.object, scopeAnalysis)) {
                return;
            }
            const name = staticMemberName(node, scopeAnalysis);
            if (name && names.has(name) && reachThrows(node)) {
                handlers.onNamedAccess(name);
            }
        },
        VariableDeclarator(node) {
            if (node.id.type === 'ObjectPattern') {
                checkDestructure(node.id, node.init);
            }
        },
        AssignmentExpression(node) {
            if (node.left.type === 'ObjectPattern') {
                checkDestructure(node.left, node.right);
            }
        },
        // A destructuring default value (`function run({ fetch } = globalThis)`) is an AssignmentPattern, unreached by the visitors above.
        AssignmentPattern(node) {
            if (node.left.type === 'ObjectPattern') {
                checkDestructure(node.left, node.right);
            }
        },
        // A for-of binding has no `.init` for the normal alias-chain check to read, so it needs its own handling — scoped to an inline array literal in the loop head, not full data-flow through an intermediate variable. ArrayPattern bindings (`for (const [x] of ...)`) aren't handled, same opacity tier as other unhandled cases.
        ForOfStatement(node) {
            if (node.right.type !== 'ArrayExpression') {
                return;
            }

            let bindingPattern: ObjectPattern | undefined;
            let bindingIdentifierVariable: eslintScope.Variable | undefined;

            if (node.left.type === 'VariableDeclaration') {
                if (node.left.declarations.length !== 1) {
                    return;
                }
                const [declarator] = node.left.declarations;
                if (declarator.id.type === 'ObjectPattern') {
                    bindingPattern = declarator.id;
                } else if (declarator.id.type === 'Identifier' && node.left.kind === 'const') {
                    bindingIdentifierVariable = findDeclaredVariable(declarator, scopeAnalysis);
                } else {
                    // A `let` binding can be reassigned in the loop body, so unlike the ObjectPattern
                    // case above it isn't provably still the ambient global — same opacity rule as a
                    // `let` alias chain.
                    return;
                }
            } else if (node.left.type === 'ObjectPattern') {
                bindingPattern = node.left;
            } else {
                // A bare-identifier target (`for (x of ...)`) always reuses an existing, reassignable
                // binding — never provably const — so it's opaque too.
                return;
            }

            const hasAmbientElement = node.right.elements.some(
                (element) =>
                    element !== null &&
                    element.type !== 'SpreadElement' &&
                    resolvesToAmbientGlobal(element, scopeAnalysis),
            );
            if (!hasAmbientElement) {
                return;
            }

            if (bindingPattern) {
                checkDestructuredPattern(bindingPattern);
            } else if (bindingIdentifierVariable) {
                forOfAmbientAliases.add(bindingIdentifierVariable);
            }
        },
    });
}
