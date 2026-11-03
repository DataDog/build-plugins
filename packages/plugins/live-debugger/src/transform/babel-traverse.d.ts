// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/**
 * Local type declaration for `@babel/traverse` that avoids the structural
 * incompatibility between `@types/babel__traverse`'s bundled copy of
 * `@babel/types` and the directly imported `@babel/types` package.
 *
 * Only the subset of the API used by this plugin is declared.
 */
declare module '@babel/traverse' {
    import type * as t from '@babel/types';

    import type { BabelPath } from './babel-path.types';

    type VisitorHandler<T extends t.Node> = (path: BabelPath<T>) => void;

    // Handlers called when the traversal enters a node and when it leaves it.
    interface VisitorHandlers<T extends t.Node> {
        enter?: VisitorHandler<T>;
        exit?: VisitorHandler<T>;
    }

    interface Visitor {
        Class?: VisitorHandler<t.Class> | VisitorHandlers<t.Class>;
        Function?: VisitorHandler<t.Function> | VisitorHandlers<t.Function>;
    }

    function traverse(ast: object, visitor: Visitor): void;

    export default traverse;
}
