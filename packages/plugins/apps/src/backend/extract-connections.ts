// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Expression, Node, ObjectExpression, Program, Property } from 'estree';
import { promises as fsp } from 'fs';
import path from 'path';

const CONNECTIONS_FILE_BASENAME = 'connections';
const CONNECTIONS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'] as const;
const CONNECTIONS_EXPORT_NAMES = ['connections', 'CONNECTIONS'] as const;
const EXPECTED_EXPORT_DESCRIPTION = '"export const CONNECTIONS" (or "connections")';

/**
 * Locate the project's connections file. Looks for `connections.{ts,tsx,js,jsx}`
 * at `buildRoot` and returns the absolute path of the first match in priority
 * order, or `undefined` when none exists.
 */
export async function findConnectionsFile(buildRoot: string): Promise<string | undefined> {
    for (const ext of CONNECTIONS_EXTENSIONS) {
        const candidate = path.join(buildRoot, `${CONNECTIONS_FILE_BASENAME}${ext}`);
        try {
            await fsp.access(candidate);
            return candidate;
        } catch {
            // not found at this extension — try the next.
        }
    }
    return undefined;
}

/**
 * Extract connection IDs from a parsed connections-file AST.
 *
 * The file must contain exactly one top-level export of the form:
 *
 *   export const CONNECTIONS = {
 *     NAME_A: 'uuid-a',
 *     NAME_B: 'uuid-b',
 *   } as const;
 *
 * `connections` (lowercase) is also accepted as the variable name.
 *
 * Values must be plain string literals or interpolation-free template literals.
 * Anything else (identifiers, env vars, concatenation, function calls, computed
 * keys, spread elements, …) throws with a framed source location so the caller
 * can surface a build-time error.
 *
 * Returns the union of values, deduplicated and sorted lexicographically for
 * deterministic manifests.
 */
export function extractConnectionIds(ast: Program, filePath: string): string[] {
    if (ast.type !== 'Program') {
        throw new Error(
            `Expected a Program node from this.parse() for ${filePath}, got ${(ast as Node).type}`,
        );
    }

    let connectionsObject: ObjectExpression | undefined;

    for (const node of ast.body) {
        if (node.type !== 'ExportNamedDeclaration' || !node.declaration) {
            continue;
        }
        const decl = node.declaration;
        if (decl.type !== 'VariableDeclaration') {
            continue;
        }
        for (const d of decl.declarations) {
            if (d.id.type !== 'Identifier' || !isConnectionsExportName(d.id.name)) {
                continue;
            }
            if (connectionsObject) {
                throw fail(
                    filePath,
                    d.loc,
                    `multiple top-level ${EXPECTED_EXPORT_DESCRIPTION} declarations are not allowed`,
                );
            }
            if (!d.init || d.init.type !== 'ObjectExpression') {
                throw fail(
                    filePath,
                    (d.init ?? d).loc,
                    `${EXPECTED_EXPORT_DESCRIPTION} must be initialized with an object literal`,
                );
            }
            connectionsObject = d.init;
        }
    }

    if (!connectionsObject) {
        throw fail(
            filePath,
            null,
            `connections file must define ${EXPECTED_EXPORT_DESCRIPTION} = { ... }`,
        );
    }

    const ids = new Set<string>();
    for (const property of connectionsObject.properties) {
        if (property.type === 'SpreadElement') {
            throw fail(
                filePath,
                property.loc,
                `spread elements are not supported inside ${EXPECTED_EXPORT_DESCRIPTION}`,
            );
        }
        if (property.computed) {
            throw fail(
                filePath,
                property.loc,
                `computed keys are not supported inside ${EXPECTED_EXPORT_DESCRIPTION}`,
            );
        }
        const keyName = readKeyName(property);
        const value = extractStaticString(property.value, keyName, filePath);
        ids.add(value);
    }

    return [...ids].sort();
}

/**
 * Resolve a property value node to its static string. Accepts string literals
 * and interpolation-free template literals; throws on anything else.
 */
function extractStaticString(value: Property['value'], keyName: string, filePath: string): string {
    if (value.type === 'Literal' && typeof value.value === 'string') {
        return value.value;
    }
    if (value.type === 'TemplateLiteral') {
        if (value.expressions.length > 0) {
            throw fail(
                filePath,
                value.loc,
                `value for "${keyName}" must be a static string — template literals with interpolations are not allowed`,
            );
        }
        const quasi = value.quasis[0];
        return quasi.value.cooked ?? quasi.value.raw;
    }
    throw fail(
        filePath,
        value.loc,
        `value for "${keyName}" must be a string literal; got ${describeNode(value)}`,
    );
}

/**
 * Read a property's key name as a string. Computed keys are rejected upstream,
 * so this only handles `Identifier` (e.g. `OPEN_AI: '...'`) and string
 * `Literal` (`'open-ai': '...'`) forms.
 */
function readKeyName(property: Property): string {
    if (property.key.type === 'Identifier') {
        return property.key.name;
    }
    if (property.key.type === 'Literal') {
        return String(property.key.value);
    }
    return '<unknown>';
}

function describeNode(node: Expression | Property['value']): string {
    return node.type;
}

function isConnectionsExportName(name: string): name is (typeof CONNECTIONS_EXPORT_NAMES)[number] {
    return (CONNECTIONS_EXPORT_NAMES as readonly string[]).includes(name);
}

function fail(filePath: string, loc: Node['loc'], reason: string): Error {
    const where = loc?.start ? `${filePath}:${loc.start.line}:${loc.start.column + 1}` : filePath;
    return new Error(`[connections] ${reason} (at ${where})`);
}
