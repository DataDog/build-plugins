// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

// This file is partially generated.
// Anything between #imports-injection-marker and #types-injection-marker
// will be updated using the 'yarn cli integrity' command.

import type { TrackedFilesMatcher } from '@dd/internal-git-plugin/trackedFilesMatcher';
/* eslint-disable arca/import-ordering */
// #imports-injection-marker
import type { ErrorTrackingOptions } from '@dd/error-tracking-plugin/types';
import type * as errorTracking from '@dd/error-tracking-plugin';
import type { RumOptions } from '@dd/rum-plugin/types';
import type * as rum from '@dd/rum-plugin';
import type { TelemetryOptions } from '@dd/telemetry-plugin/types';
import type * as telemetry from '@dd/telemetry-plugin';
// #imports-injection-marker
/* eslint-enable arca/import-ordering */
import type { BodyInit } from 'undici-types';
import type { UnpluginOptions } from 'unplugin';

import type { FULL_NAME_BUNDLERS, SUPPORTED_BUNDLERS } from './constants';

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
    logs: { pluginName: string; type: LogLevel; message: string; time: number }[];
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

export type BundlerFullName = (typeof FULL_NAME_BUNDLERS)[number];
export type BundlerName = (typeof SUPPORTED_BUNDLERS)[number];
export type BundlerReport = {
    name: BundlerName;
    fullName: BundlerFullName;
    outDir: string;
    rawConfig?: any;
    variant?: string; // e.g. Major version of the bundler (webpack 4, webpack 5)
    version: string;
};

export type InjectedValue = string | (() => Promise<string>);
export enum InjectPosition {
    BEFORE,
    MIDDLE,
    AFTER,
}
export type ToInjectItem = {
    type: 'file' | 'code';
    value: InjectedValue;
    position?: InjectPosition;
    fallback?: ToInjectItem;
};

export type GetLogger = (name: string) => Logger;
export type Logger = {
    getLogger: GetLogger;
    error: (text: any) => void;
    warn: (text: any) => void;
    info: (text: any) => void;
    debug: (text: any) => void;
};
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

export type PluginOptions = UnpluginOptions & {
    name: PluginName;
};

export type GetPlugins<T> = (options: T, context: GlobalContext, log: Logger) => PluginOptions[];
export type GetCustomPlugins = (
    options: Options,
    context: GlobalContext,
    log: Logger,
) => UnpluginOptions[];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

export type AuthOptions = {
    apiKey?: string;
    appKey?: string;
};

export interface BaseOptions {
    auth?: AuthOptions;
    devServer?: boolean;
    disableGit?: boolean;
    logLevel?: LogLevel;
}

export interface Options extends BaseOptions {
    // Each product should have a unique entry.
    // #types-injection-marker
    [errorTracking.CONFIG_KEY]?: ErrorTrackingOptions;
    [rum.CONFIG_KEY]?: RumOptions;
    [telemetry.CONFIG_KEY]?: TelemetryOptions;
    // #types-injection-marker
    customPlugins?: GetCustomPlugins;
}

export type GetPluginsOptions = Required<BaseOptions>;
export type OptionsWithDefaults = Assign<Options, GetPluginsOptions>;

export type PluginName = `datadog-${Lowercase<string>}-plugin`;

type Data = { data?: BodyInit; headers?: Record<string, string> };
export type RequestOpts = {
    url: string;
    auth?: AuthOptions;
    method?: string;
    getData?: () => Promise<Data> | Data;
    type?: 'json' | 'text';
    onRetry?: (error: Error, attempt: number) => void;
};

export type ResolvedEntry = { name?: string; resolved: string; original: string };
