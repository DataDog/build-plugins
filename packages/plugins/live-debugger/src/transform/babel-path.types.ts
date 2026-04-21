// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type * as t from '@babel/types';

/**
 * Minimal NodePath-compatible interface using types exclusively from
 * `@babel/types`. This avoids the type conflict between
 * `@types/babel__traverse`'s bundled copy of `@babel/types` and the
 * directly imported `@babel/types` package.
 */
export interface BabelPath<T extends t.Node = t.Node> {
    node: T;
    parent: t.Node;
    parentPath: BabelPath | null;
}

/**
 * Runtime `@babel/types` namespace passed as an argument everywhere a
 * helper needs `t.isXXX` guards. Threading the module through (instead
 * of importing it at module scope) lets the transform code keep Babel
 * off the hot path until the plugin is actually used at build time.
 */
export type BabelTypesModule = typeof import('@babel/types');
