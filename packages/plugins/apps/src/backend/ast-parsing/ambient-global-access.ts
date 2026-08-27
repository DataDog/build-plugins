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
import { staticStringValue } from './type-guards';
import { walkAst } from './walk-ast';

const GLOBAL_THIS_NAME = 'globalThis';
const NODE_GLOBAL_ALIAS_NAME = 'global';

// `global` is Node's own alias for the ambient global object.
function isAmbientGlobalReceiverName(name: string): boolean {
    return name === GLOBAL_THIS_NAME || name === NODE_GLOBAL_ALIAS_NAME;
}

// Only an unresolved `globalThis`/`global` identifier or a chain of single-`const` aliases counts — a `let`, parameter, or ambiguous binding is treated as opaque to avoid a false positive from something that might not always hold the ambient global.
function resolvesToAmbientGlobal(
    node: Expression | Super,
    scopeAnalysis: ModuleScopeAnalysis,
    visited: Set<eslintScope.Variable> = new Set(),
): boolean {
    // `globalThis.globalThis`/`global.global` is a real, valid self-reference — recurse through it before falling back to opaque for any other receiver shape.
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

    if (visited.has(variable) || variable.defs.length !== 1) {
        return false;
    }
    visited.add(variable);

    const [definition] = variable.defs;
    if (definition.type !== 'Variable' || definition.parent.kind !== 'const') {
        return false;
    }

    // Cast needed: `definition.node` is typed against eslint's bundled `@types/estree`, a distinct package from the `estree` types used elsewhere in this file.
    const declarator = definition.node as VariableDeclarator;
    // A destructured binding (`const { x } = y`) names a specific property of `y`, not `y` itself, so it must not inherit `y`'s ambient-global identity.
    if (declarator.id.type !== 'Identifier' || !declarator.init) {
        return false;
    }

    return resolvesToAmbientGlobal(declarator.init, scopeAnalysis, visited);
}

function staticMemberName(node: MemberExpression): string | undefined {
    if (!node.computed) {
        return node.property.type === 'Identifier' ? node.property.name : undefined;
    }
    return staticStringValue(node.property);
}

function staticPropertyName(property: Property): string | undefined {
    // A non-computed key can still be a quoted string literal (`{ 'fetch': f }`), not just an Identifier — fall through to staticStringValue so that shape resolves too.
    if (!property.computed && property.key.type === 'Identifier') {
        return property.key.name;
    }
    return staticStringValue(property.key);
}

export interface AmbientGlobalAccessHandlers {
    /** A specific restricted/divergent name was reached by name. */
    onNamedAccess(name: string): void;
    /** A rest destructure of `globalThis`/`global` copied every ambient global at once, with no specific name to report. */
    onRestDestructure(): void;
}

// Walks every syntactic form that can reach the ambient global object and reports matching names; shared by `rejectRestrictedGlobals` and `warnAboutDivergentGlobals`, which only differ in throw vs. warn.
export function forEachAmbientGlobalAccess(
    program: Program,
    scopeAnalysis: ModuleScopeAnalysis,
    names: ReadonlySet<string>,
    handlers: AmbientGlobalAccessHandlers,
): void {
    for (const [identifier, reference] of scopeAnalysis.referencesByIdentifier) {
        if (!names.has(identifier.name) || reference.resolved) {
            continue;
        }
        handlers.onNamedAccess(identifier.name);
    }

    const checkDestructure = (pattern: ObjectPattern, init: Expression | null | undefined) => {
        if (!init || !resolvesToAmbientGlobal(init, scopeAnalysis)) {
            return;
        }
        for (const property of pattern.properties) {
            if (property.type === 'RestElement') {
                handlers.onRestDestructure();
                continue;
            }
            const name = staticPropertyName(property);
            if (name && names.has(name)) {
                handlers.onNamedAccess(name);
            }
        }
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
        // A destructuring default value (`function run({ fetch } = globalThis)`) is an AssignmentPattern, not reached by the VariableDeclarator/AssignmentExpression visitors above.
        AssignmentPattern(node) {
            if (node.left.type === 'ObjectPattern') {
                checkDestructure(node.left, node.right);
            }
        },
        // The mirror image of a rest-destructure — `{ ...globalThis }` copies every ambient global into a new object just as `const { ...x } = globalThis` does.
        ObjectExpression(node: ObjectExpression) {
            for (const property of node.properties) {
                if (
                    property.type === 'SpreadElement' &&
                    resolvesToAmbientGlobal(property.argument, scopeAnalysis)
                ) {
                    handlers.onRestDestructure();
                }
            }
        },
    });
}
