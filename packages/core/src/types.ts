// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// This file is partially generated.
// Anything between #imports-injection-marker and #types-injection-marker
// will be updated using the 'yarn cli integrity' command.

/* eslint-disable arca/import-ordering */
// #imports-injection-marker
import type { RumOptions } from '@dd/rum-plugins/types';
import type * as rum from '@dd/rum-plugins';
import type { TelemetryOptions } from '@dd/telemetry-plugins/types';
import type * as telemetry from '@dd/telemetry-plugins';
// #imports-injection-marker
/* eslint-enable arca/import-ordering */

import type { BodyInit } from 'undici-types';
import type { UnpluginContextMeta, UnpluginOptions } from 'unplugin';

import type { TrackedFilesMatcher } from './plugins/git/trackedFilesMatcher';

export type Assign<A, B> = Omit<A, keyof B> & B;
export type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };
export type IterableElement<IterableType extends Iterable<unknown>> =
    IterableType extends Iterable<infer ElementType> ? ElementType : never;

export interface RepositoryData {
    hash: string;
    remote: string;
    trackedFilesMatcher: TrackedFilesMatcher;
}

export type File = { filepath: string; name: string; size: number; type: string };
export type Input = File & { dependencies: Set<Input>; dependents: Set<Input> };
export type Output = File & { inputs: (Input | Output)[] };
export type Entry = Output & { outputs: Output[] };

export type SerializedEntry = Assign<Entry, { inputs: string[]; outputs: string[] }>;
export type SerializedInput = Assign<Input, { dependencies: string[]; dependents: string[] }>;
export type SerializedOutput = Assign<Output, { inputs: string[] }>;

export type BuildReport = {
    errors: string[];
    warnings: string[];
    entries?: Entry[];
    inputs?: Input[];
    outputs?: Output[];
    start?: number;
    end?: number;
    duration?: number;
    writeDuration?: number;
};

// A JSON safe version of the report.
export type SerializedBuildReport = Assign<
    BuildReport,
    {
        entries: SerializedEntry[];
        inputs: SerializedInput[];
        outputs: SerializedOutput[];
    }
>;

export type BundlerFullName = 'webpack5' | 'webpack4' | 'esbuild' | 'vite' | 'rollup';
export type BundlerName = 'webpack' | 'esbuild' | 'vite' | 'rollup';
export type BundlerReport = {
    name: BundlerName;
    fullName: BundlerFullName;
    outDir: string;
    rawConfig?: any;
    variant?: string; // e.g. Major version of the bundler (webpack 4, webpack 5)
    version: string;
};

export type ToInjectItem = { type: 'file' | 'code'; value: string; fallback?: ToInjectItem };

export type GlobalContext = {
    auth?: AuthOptions;
    inject: (item: ToInjectItem) => void;
    bundler: BundlerReport;
    build: BuildReport;
    cwd: string;
    git?: RepositoryData;
    pluginNames: string[];
    start: number;
    version: string;
};

export type FactoryMeta = {
    bundler: any;
    version: string;
};

export type Meta = UnpluginContextMeta & FactoryMeta;

export type PluginOptions = UnpluginOptions & {
    name: PluginName;
};

export type GetPlugins<T> = (options: T, context: GlobalContext) => PluginOptions[];
export type GetCustomPlugins<T> = (options: T, context: GlobalContext) => UnpluginOptions[];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

export type AuthOptions = {
    apiKey?: string;
};

export interface GetPluginsOptions {
    auth?: AuthOptions;
    disableGit?: boolean;
    logLevel?: LogLevel;
}

export interface Options extends GetPluginsOptions {
    // Each product should have a unique entry.
    // #types-injection-marker
    [rum.CONFIG_KEY]?: RumOptions;
    [telemetry.CONFIG_KEY]?: TelemetryOptions;
    // #types-injection-marker
    customPlugins?: GetCustomPlugins<Options>;
}

export type PluginName = `datadog-${Lowercase<string>}-plugin`;

type Data = { data: BodyInit; headers?: Record<string, string> };
export type RequestOpts = {
    url: string;
    method?: string;
    getData?: () => Promise<Data> | Data;
    type?: 'json' | 'text';
    onRetry?: (error: Error, attempt: number) => void;
};
