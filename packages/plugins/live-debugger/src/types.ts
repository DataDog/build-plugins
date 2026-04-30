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

export type LiveDebuggerOptions = {
    enable?: boolean;
    include?: (string | RegExp)[];
    exclude?: (string | RegExp)[];
    honorSkipComments?: boolean;
    functionTypes?: FunctionKind[];
    namedOnly?: boolean;
};

export type LiveDebuggerOptionsWithDefaults = {
    enable: boolean;
    version: string | undefined;
    include: (string | RegExp)[];
    exclude: (string | RegExp)[];
    honorSkipComments: boolean;
    functionTypes: FunctionKind[] | undefined;
    namedOnly: boolean;
};
