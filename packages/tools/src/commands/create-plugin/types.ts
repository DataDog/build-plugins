// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Workspace } from '@dd/tools/types';

import type { bundlerHookNames, typesOfPlugin, universalHookNames } from './constants';

export type TypeOfPlugin = (typeof typesOfPlugin)[number];
export type BundlerHook = (typeof bundlerHookNames)[number];
export type UniversalHook = (typeof universalHookNames)[number];

export type AnyHook = BundlerHook | UniversalHook;

export type Hook = {
    name: string;
    descriptions: string[];
};

export type EitherHookTable = BundlerHook[] | UniversalHook[];
export type EitherHookList = Record<UniversalHook, Hook> | Record<BundlerHook, Hook>;
export type AllHookList = Record<UniversalHook, Hook> & Record<BundlerHook, Hook>;

export type Answers = {
    description?: string;
    codeowners?: string;
    hooks?: EitherHookTable;
};

export type Context = Required<Answers> & {
    plugin: Workspace;
};

export type File = {
    name: string;
    condition?: (context: Context) => boolean;
    content: (context: Context) => string;
};