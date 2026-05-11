// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode, Program, SimpleLiteral } from 'estree';

export type StringLiteral = SimpleLiteral & { value: string };

// Rollup's parser preserves TypeScript import/export kind metadata on otherwise
// ESTree-shaped import/export nodes.
type TypeOnlyAwareNode = BaseNode & { importKind?: string; exportKind?: string };

export function ensureProgram(node: BaseNode, filePath: string): Program {
    if (!isProgramNode(node)) {
        throw new Error(
            `Expected a Program node from this.parse() for ${filePath}, got ${node.type}`,
        );
    }
    return node;
}

export function isProgramNode(node: BaseNode): node is Program {
    return node.type === 'Program';
}

export function isStringLiteral(node: unknown): node is StringLiteral {
    return (
        typeof node === 'object' &&
        node !== null &&
        (node as { type?: string }).type === 'Literal' &&
        typeof (node as { value?: unknown }).value === 'string'
    );
}

export function isTypeOnly(node: TypeOnlyAwareNode): boolean {
    return node.importKind === 'type' || node.exportKind === 'type';
}
