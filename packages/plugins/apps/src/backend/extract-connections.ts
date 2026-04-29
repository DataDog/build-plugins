// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Node, ObjectExpression, Program, Property } from 'estree';
import { promises as fsp } from 'fs';
import path from 'path';

const CONNECTIONS_FILE_BASENAME = 'connections';
const CONNECTIONS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'] as const;
const CONNECTIONS_EXPORT_NAME = 'CONNECTIONS';
const EXPECTED_EXPORT_DESCRIPTION = `"export const ${CONNECTIONS_EXPORT_NAME}"`;

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

type WithOffset = Node & { start?: number };

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
 * Values must be plain string literals or interpolation-free template literals.
 * Anything else (identifiers, env vars, concatenation, function calls, computed
 * keys, spread elements, …) throws with a framed source location so the caller
 * can surface a build-time error. `code` is the original source text used to
 * resolve `node.start` offsets to line:col coordinates.
 *
 * Returns the union of values, deduplicated and sorted lexicographically for
 * deterministic manifests.
 */
export function extractConnectionIds(ast: Program, filePath: string, code: string): string[] {
    if (ast.type !== 'Program') {
        throw new Error(
            `Expected a Program node from this.parse() for ${filePath}, got ${(ast as Node).type}`,
        );
    }

    const fail = (node: WithOffset | null | undefined, reason: string): Error => {
        const where =
            node?.start != null ? `${filePath}:${formatLineCol(code, node.start)}` : filePath;
        return new Error(`[connections] ${reason} (at ${where})`);
    };

    let connectionsObject: ObjectExpression | undefined;

    // Find: export const CONNECTIONS = {};
    for (const node of ast.body) {
        if (node.type !== 'ExportNamedDeclaration' || !node.declaration) {
            continue;
        }
        const decl = node.declaration;
        if (decl.type !== 'VariableDeclaration') {
            continue;
        }
        for (const d of decl.declarations) {
            if (d.id.type !== 'Identifier' || d.id.name !== CONNECTIONS_EXPORT_NAME) {
                continue;
            }
            if (connectionsObject) {
                throw fail(
                    d,
                    `multiple top-level ${EXPECTED_EXPORT_DESCRIPTION} declarations are not allowed`,
                );
            }
            if (!d.init || d.init.type !== 'ObjectExpression') {
                throw fail(
                    d.init ?? d,
                    `${EXPECTED_EXPORT_DESCRIPTION} must be initialized with an object literal`,
                );
            }
            connectionsObject = d.init;
        }
    }

    if (!connectionsObject) {
        throw fail(null, `connections file must define ${EXPECTED_EXPORT_DESCRIPTION} = { ... }`);
    }

    const ids = new Set<string>();
    // Validate and extract the CONNECTIONS object data
    for (const property of connectionsObject.properties) {
        if (property.type === 'SpreadElement') {
            throw fail(
                property,
                `spread elements are not supported inside ${EXPECTED_EXPORT_DESCRIPTION}`,
            );
        }
        if (property.computed) {
            throw fail(
                property,
                `computed keys are not supported inside ${EXPECTED_EXPORT_DESCRIPTION}`,
            );
        }
        const keyName = readKeyName(property);
        const value = extractStaticString(property.value, keyName, fail);
        ids.add(value);
    }

    return [...ids].sort();
}

/**
 * Resolve a property value node to its static string. Accepts string literals
 * and interpolation-free template literals; throws on anything else.
 *
 * This return the value of literal string ('HELLO') and template literals with no expressions: (`World`).
 * It will throw on everything else.
 *
 */
function extractStaticString(
    value: Property['value'],
    keyName: string,
    fail: (node: WithOffset | null | undefined, reason: string) => Error,
): string {
    if (value.type === 'Literal' && typeof value.value === 'string') {
        return value.value;
    }
    if (value.type === 'TemplateLiteral') {
        if (value.expressions.length > 0) {
            throw fail(
                value,
                `value for "${keyName}" must be a static string — template literals with interpolations are not allowed`,
            );
        }
        const quasi = value.quasis[0];
        return quasi.value.cooked ?? quasi.value.raw;
    }
    throw fail(value, `value for "${keyName}" must be a string literal; got ${value.type}`);
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

/**
 * Convert a 0-based byte offset into a `line:column` string (1-based, like
 * editor jump-to-line targets).
 */
function formatLineCol(code: string, offset: number): string {
    const before = code.slice(0, offset);
    const newlineCount = (before.match(/\n/g) ?? []).length;
    const lastNewline = before.lastIndexOf('\n');
    const line = newlineCount + 1;
    const column = offset - (lastNewline + 1) + 1;
    return `${line}:${column}`;
}
