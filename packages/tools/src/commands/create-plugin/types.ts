// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { IterableElement } from '@dd/core/types';
import type { Workspace } from '@dd/tools/types';

import type { bundlerHookNames, typesOfPlugin, universalHookNames } from './constants';

export type TypeOfPlugin = IterableElement<typeof typesOfPlugin>;
export type BundlerHook = IterableElement<typeof bundlerHookNames>;
export type UniversalHook = IterableElement<typeof universalHookNames>;

export type AnyHook = BundlerHook | UniversalHook;

export type Choice = {
    name: string;
    descriptions: string[];
};

export type AllHookList = Record<UniversalHook, Choice> & Record<BundlerHook, Choice>;

export type Answers = {
    description?: string;
    codeowners?: string;
    hooks?: AnyHook[];
    type?: TypeOfPlugin;
};

export type Context = Required<Answers> & {
    plugin: Workspace;
};

export type File = {
    name: string;
    content: (context: Context) => string;
};
