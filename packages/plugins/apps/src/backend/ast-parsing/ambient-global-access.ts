// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type * as eslintScope from 'eslint-scope';
import type {
    Expression,
    MemberExpression,
    ObjectExpression,
    ObjectPattern,
    Program,
    Property,
    Super,
    VariableDeclarator,
} from 'estree';

import { resolveIdentifier } from './module-scope';
import type { ModuleScopeAnalysis } from './module-scope';
import { isVariableDeclaratorNode, staticStringValue } from './type-guards';
import { walkAst } from './walk-ast';

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
        const propertyName = staticMemberName(node);
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
    // A destructure normally names a property of `y`, not `y` itself — unless the key is a `globalThis`/`global` self-reference (`const { globalThis: g } = globalThis`), since `y.globalThis === y` makes `g` a real alias.
    if (id.type === 'ObjectPattern') {
        const selfReferenceProperty = id.properties.find((property) => {
            if (property.type !== 'Property') {
                return false;
            }
            const propertyName = staticPropertyName(property) ?? '';
            return (
                unwrapDefaultValue(property.value) === definition.name &&
                isAmbientGlobalReceiverName(propertyName)
            );
        });
        if (selfReferenceProperty) {
            return resolvesToAmbientGlobal(init, scopeAnalysis, visited);
        }
    }

    return false;
}

function staticMemberName(node: MemberExpression): string | undefined {
    if (!node.computed) {
        return node.property.type === 'Identifier' ? node.property.name : undefined;
    }
    return staticStringValue(node.property);
}

// A defaulted property value (`{ x = fallback }`) is an AssignmentPattern wrapping the real binding — unwrap it so a defaulted alias is treated the same as a bare one.
function unwrapDefaultValue(value: Property['value']): Property['value'] {
    return value.type === 'AssignmentPattern' ? value.left : value;
}

function staticPropertyName(property: Property): string | undefined {
    // A non-computed key can still be a quoted string literal (`{ 'fetch': f }`) — fall through to staticStringValue for that shape.
    if (!property.computed && property.key.type === 'Identifier') {
        return property.key.name;
    }
    return staticStringValue(property.key);
}

// A for-of binding identifier is a declaration site, not a reference, so `resolveIdentifier` (which only resolves references) can't find it — look it up via eslint-scope's declarator-to-Variable index instead.
function findDeclaredVariable(
    declarator: VariableDeclarator,
    scopeAnalysis: ModuleScopeAnalysis,
): eslintScope.Variable | undefined {
    return scopeAnalysis.scopeManager.getDeclaredVariables(declarator)[0];
}

// Standard-library statics that reify every property VALUE of their argument at once (see the CallExpression visitor below). `Object.keys`/`Reflect.ownKeys` are excluded since they return only name strings, not values. Matched by identifier name only — a locally-shadowed `Object`/`Reflect` is an accepted gap.
const BULK_COPY_CALLS: ReadonlyArray<{ readonly object: string; readonly property: string }> = [
    { object: 'Object', property: 'assign' },
    { object: 'Object', property: 'values' },
    { object: 'Object', property: 'entries' },
    { object: 'Object', property: 'getOwnPropertyDescriptors' },
];

function matchesBulkCopyCall(callee: Expression | Super): boolean {
    if (callee.type !== 'MemberExpression' || callee.computed) {
        return false;
    }
    if (callee.object.type !== 'Identifier' || callee.property.type !== 'Identifier') {
        return false;
    }
    const objectName = callee.object.name;
    const propertyName = callee.property.name;
    return BULK_COPY_CALLS.some(
        (candidate) => candidate.object === objectName && candidate.property === propertyName,
    );
}

export interface AmbientGlobalAccessHandlers {
    /** A specific restricted/divergent name was reached by name. */
    onNamedAccess(name: string): void;
    /** Every ambient global was copied at once (a rest destructure, an object spread, or a bulk-copy call like `Object.assign`/`Object.values`), with no specific name to report. */
    onBulkCopy(): void;
}

// Walks every syntactic form that can reach the ambient global object and reports matching names; shared by `rejectRestrictedGlobals` and `warnAboutDivergentGlobals`.
export function forEachAmbientGlobalAccess(
    program: Program,
    scopeAnalysis: ModuleScopeAnalysis,
    names: ReadonlySet<string>,
    handlers: AmbientGlobalAccessHandlers,
): void {
    forOfAmbientAliases = new Set();

    for (const [identifier, reference] of scopeAnalysis.referencesByIdentifier) {
        if (!names.has(identifier.name) || reference.resolved) {
            continue;
        }
        handlers.onNamedAccess(identifier.name);
    }

    // Shared by both `const { x } = globalThis`-style destructures and a for-of loop's inline destructure below — the per-property checking is identical once the source is known to be the ambient global.
    const checkDestructuredPattern = (pattern: ObjectPattern) => {
        for (const property of pattern.properties) {
            if (property.type === 'RestElement') {
                handlers.onBulkCopy();
                continue;
            }
            const name = staticPropertyName(property);
            if (name && names.has(name)) {
                handlers.onNamedAccess(name);
            }
            // `const { globalThis: { fetch } } = globalThis` is a real self-reference, so recurse the same way resolvesToAmbientGlobal's MemberExpression case does — otherwise a name nested inside a `globalThis`/`global` key escapes detection.
            const nestedPattern = unwrapDefaultValue(property.value);
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
            const name = staticMemberName(node);
            if (name && names.has(name)) {
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
        // Mirrors a rest-destructure — `{ ...globalThis }` copies every ambient global just as `const { ...x } = globalThis` does.
        ObjectExpression(node: ObjectExpression) {
            for (const property of node.properties) {
                if (
                    property.type === 'SpreadElement' &&
                    resolvesToAmbientGlobal(property.argument, scopeAnalysis)
                ) {
                    handlers.onBulkCopy();
                }
            }
        },
        // Built-in statics like `Object.assign({}, globalThis)` reify every property at once — the same threat as a rest-destructure or spread, but with no named-property access for the visitors above to see. Scoped to this known list, not a user-defined equivalent or an aliased `Object`/`Reflect`.
        CallExpression(node) {
            if (!matchesBulkCopyCall(node.callee)) {
                return;
            }
            const hasAmbientArgument = node.arguments.some(
                (arg) =>
                    arg.type !== 'SpreadElement' && resolvesToAmbientGlobal(arg, scopeAnalysis),
            );
            if (hasAmbientArgument) {
                handlers.onBulkCopy();
            }
        },
    });
}
