// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { BaseNode, Program } from 'estree';

const ACTION_CATALOG_PACKAGE = '@datadog/action-catalog';

export interface ActionCatalogImports {
    functions: Set<string>;
    namespaces: Set<string>;
}

type NodeWithOptionalImportKind = BaseNode & { importKind?: string };

export function collectActionCatalogImports(ast: Program): ActionCatalogImports {
    const functions = new Set<string>();
    const namespaces = new Set<string>();

    for (const node of ast.body) {
        if (node.type !== 'ImportDeclaration' || !isActionCatalogSource(node.source.value)) {
            continue;
        }
        if (isTypeOnly(node)) {
            continue;
        }

        for (const specifier of node.specifiers) {
            if (isTypeOnly(specifier)) {
                continue;
            }

            if (specifier.type === 'ImportNamespaceSpecifier') {
                namespaces.add(specifier.local.name);
            } else {
                functions.add(specifier.local.name);
            }
        }
    }

    return { functions, namespaces };
}

export function hasActionCatalogImports(imports: ActionCatalogImports): boolean {
    return imports.functions.size > 0 || imports.namespaces.size > 0;
}

function isActionCatalogSource(source: unknown): boolean {
    return (
        typeof source === 'string' &&
        (source === ACTION_CATALOG_PACKAGE || source.startsWith(`${ACTION_CATALOG_PACKAGE}/`))
    );
}

function isTypeOnly(node: NodeWithOptionalImportKind): boolean {
    return node.importKind === 'type';
}
