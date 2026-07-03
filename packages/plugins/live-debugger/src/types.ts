// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export const VALID_FUNCTION_KINDS = [
    'functionDeclaration',
    'functionExpression',
    'arrowFunction',
    'objectMethod',
    'classMethod',
    'classPrivateMethod',
] as const;

export type FunctionKind = (typeof VALID_FUNCTION_KINDS)[number];

// Which decorator syntax the parser should accept. `legacy` matches
// TypeScript's `experimentalDecorators` (Angular, NestJS, TypeORM, including
// parameter decorators); `modern` matches the TC39 Stage 3 proposal
// (`accessor` fields, decorators before `export`).
export const VALID_DECORATOR_SYNTAXES = ['legacy', 'modern'] as const;

export type DecoratorSyntax = (typeof VALID_DECORATOR_SYNTAXES)[number];

export type LiveDebuggerOptions = {
    enable?: boolean;
    include?: (string | RegExp)[];
    exclude?: (string | RegExp)[];
    honorSkipComments?: boolean;
    functionTypes?: FunctionKind[];
    namedOnly?: boolean;
    decorators?: DecoratorSyntax;
};

export type LiveDebuggerOptionsWithDefaults = {
    version: string | undefined;
    include: (string | RegExp)[];
    exclude: (string | RegExp)[];
    honorSkipComments: boolean;
    functionTypes: FunctionKind[] | undefined;
    namedOnly: boolean;
    decorators: DecoratorSyntax;
};
