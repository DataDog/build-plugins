// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode, Program, SimpleLiteral, TemplateLiteral, VariableDeclarator } from 'estree';

export type StringLiteral = SimpleLiteral & { value: string };

export interface TypeScriptImportExportMetadata {
    importKind?: 'type' | 'value';
    exportKind?: 'type' | 'value';
}

type TypeOnlyAwareNode = BaseNode & TypeScriptImportExportMetadata;

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
    if (typeof node !== 'object' || node === null || !('type' in node) || !('value' in node)) {
        return false;
    }
    return node.type === 'Literal' && typeof node.value === 'string';
}

export function isTypeOnly(node: TypeOnlyAwareNode): boolean {
    return node.importKind === 'type' || node.exportKind === 'type';
}

export function isVariableDeclaratorNode(node: unknown): node is VariableDeclarator {
    return (
        typeof node === 'object' &&
        node !== null &&
        'type' in node &&
        node.type === 'VariableDeclarator'
    );
}

function isNoSubstitutionTemplateLiteral(node: unknown): node is TemplateLiteral {
    if (
        typeof node !== 'object' ||
        node === null ||
        !('type' in node) ||
        !('expressions' in node) ||
        !('quasis' in node)
    ) {
        return false;
    }
    return (
        node.type === 'TemplateLiteral' &&
        Array.isArray(node.expressions) &&
        node.expressions.length === 0 &&
        Array.isArray(node.quasis) &&
        node.quasis.length === 1
    );
}

// Resolves the static string value of a `Literal` or no-substitution template literal — the only two forms knowable without evaluation.
export function staticStringValue(node: unknown): string | undefined {
    if (isStringLiteral(node)) {
        return node.value;
    }
    if (isNoSubstitutionTemplateLiteral(node)) {
        return node.quasis[0].value.cooked ?? undefined;
    }
    return undefined;
}
