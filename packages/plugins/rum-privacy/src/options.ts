// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export interface PluginOptions {
    exclude: RegExp[] | string[];
    include: RegExp[] | string[];
    module: 'cjs' | 'esm' | undefined;
    jsx: boolean | undefined;
    transformStrategy: 'ast' | undefined;
    typescript: boolean | undefined;
}

export const defaultPluginOptions: PluginOptions = {
    exclude: [/\/node_modules\//, /\.preval\./],
    include: [/\.(?:c|m)?(?:j|t)sx?$/],
    module: 'esm',
    jsx: undefined,
    transformStrategy: 'ast',
    typescript: undefined,
};
