// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export type Answers = {
    webpack?: boolean;
    esbuild?: boolean;
    tests?: boolean;
    description?: string;
    codeowners?: string;
};

export type Workspace = {
    name: string;
    slug: string;
    location: string;
};

export type Context = Required<Answers> & {
    plugin: Workspace;
};

export type File = {
    name: string;
    condition?: (context: Context) => boolean;
    content: (context: Context) => string;
};

export type SlugLessWorkspace = Omit<Workspace, 'slug'>;
