// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Program } from 'estree';
import type { AstNode } from 'rollup';

export function isProgramNode(node: AstNode): node is AstNode & Program {
    return node.type === 'Program';
}
