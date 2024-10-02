import type { Workspace } from '@dd/tools/types';

import type { bundlerHooks, typesOfPlugin, universalHooks } from './constants';

export type TypeOfPlugin = (typeof typesOfPlugin)[number];
export type BundlerHook = (typeof bundlerHooks)[number];
export type UniversalHook = (typeof universalHooks)[number];

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
