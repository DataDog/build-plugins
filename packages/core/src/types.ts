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
import type { MetricsOptions } from '@dd/metrics-plugin/types';
import type * as metrics from '@dd/metrics-plugin';
import type { RumOptions } from '@dd/rum-plugin/types';
import type * as rum from '@dd/rum-plugin';
// #imports-injection-marker
/* eslint-enable arca/import-ordering */
import type { BodyInit } from 'undici-types';
import type { UnpluginOptions } from 'unplugin';

import type { ALL_ENVS, SUPPORTED_BUNDLERS } from './constants';

export type Assign<A, B> = Omit<A, keyof B> & B;
export type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };
export type IterableElement<IterableType extends Iterable<unknown>> =
    IterableType extends Iterable<infer ElementType> ? ElementType : never;

export interface RepositoryData {
    commit: {
        hash: string;
        message: string;
        author: {
            name: string;
            email: string;
            date: string;
        };
        committer: {
            name: string;
            email: string;
            date: string;
        };
    };
    hash: string;
    branch: string;
    remote: string;
    trackedFilesMatcher: TrackedFilesMatcher;
}

export type FileReport = { filepath: string; name: string; size: number; type: string };
export type Input = FileReport & { dependencies: Set<Input>; dependents: Set<Input> };
export type Output = FileReport & { inputs: (Input | Output)[] };
export type Entry = Output & { outputs: Output[] };

export type SerializedEntry = Assign<Entry, { inputs: string[]; outputs: string[] }>;
export type SerializedInput = Assign<Input, { dependencies: string[]; dependents: string[] }>;
export type SerializedOutput = Assign<Output, { inputs: string[] }>;

export type Log = {
    bundler?: BundlerName;
    pluginName: string;
    type: LogLevel;
    message: string;
    time: number;
};
export type LogTags = string[];
export type Timer = {
    label: string;
    pluginName: string;
    spans: { start: number; end?: number; tags: LogTags }[];
    tags: LogTags;
    total: number;
    logLevel: LogLevel;
};

export type BuildMetadata = {
    name?: string;
};

export type BuildReport = {
    bundler: GlobalData['bundler'];
    errors: GlobalStores['errors'];
    warnings: GlobalStores['warnings'];
    logs: GlobalStores['logs'];
    timings: GlobalStores['timings'];
    metadata: GlobalData['metadata'];
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

export type BundlerName = (typeof SUPPORTED_BUNDLERS)[number];
export type BundlerReport = GlobalData['bundler'] & {
    outDir: string;
    rawConfig?: any;
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

export type TimeLogger = {
    timer: Timer;
    resume: (startTime?: number) => void;
    end: (endTime?: number) => void;
    pause: (pauseTime?: number, warn?: boolean) => void;
    tag: (tags: LogTags, opts?: { span?: boolean }) => void;
};

// The rest parameter is a LogLevel or a boolean to auto start the timer.
export type TimeLog = (
    label: string,
    opts?: { level?: LogLevel; start?: boolean | number; log?: boolean; tags?: LogTags },
) => TimeLogger;
export type GetLogger = (name: string) => Logger;
export type LogOptions = { forward?: boolean };
export type LoggerFn = (text: any, opts?: LogOptions) => void;
export type Logger = {
    getLogger: GetLogger;
    time: TimeLog;
    error: LoggerFn;
    warn: LoggerFn;
    info: LoggerFn;
    debug: LoggerFn;
};
type RestContext = string | string[] | number | boolean;
export type LogData = Record<string, RestContext | Record<string, RestContext>>;
export type DdLogOptions = {
    message: string;
    context?: LogData;
};
export type Env = (typeof ALL_ENVS)[number];
export type TriggerHook<R> = <K extends keyof CustomHooks>(
    name: K,
    ...args: Parameters<NonNullable<CustomHooks[K]>>
) => R;
export type GlobalContext = {
    asyncHook: TriggerHook<Promise<void[]>>;
    auth: AuthOptionsWithDefaults;
    build: BuildReport;
    bundler: BundlerReport;
    buildRoot: string;
    env: GlobalData['env'];
    getLogger: GetLogger;
    git?: RepositoryData;
    hook: TriggerHook<void>;
    inject: (item: ToInjectItem) => void;
    pluginNames: string[];
    plugins: (PluginOptions | CustomPluginOptions)[];
    queue: (promise: Promise<any>) => void;
    sendLog: (args: DdLogOptions) => Promise<void>;
    start: number;
    version: GlobalData['version'];
};

export type FactoryMeta = {
    bundler: any;
    version: string;
};

export type HookFn<T extends Array<any>> = (...args: T) => void;
export type AsyncHookFn<T extends Array<any>> = (...args: T) => Promise<void> | void;
export type CustomHooks = {
    asyncTrueEnd?: () => Promise<void> | void;
    buildRoot?: HookFn<[string]>;
    init?: HookFn<[GlobalContext]>;
    buildReport?: AsyncHookFn<[BuildReport]>;
    bundlerReport?: HookFn<[BundlerReport]>;
    git?: AsyncHookFn<[RepositoryData]>;
    metricsBundlerContext?: AsyncHookFn<[Report]>;
    syncTrueEnd?: () => void;
};

export type PluginOptions = Assign<
    UnpluginOptions & CustomHooks,
    {
        name: PluginName;
    }
>;

export type CustomPluginOptions = Assign<
    PluginOptions,
    {
        name: string;
    }
>;

export type GetPluginsArg = {
    bundler: any;
    context: GlobalContext;
    options: OptionsWithDefaults;
    data: GlobalData;
    stores: GlobalStores;
};
export type GetPlugins = (arg: GetPluginsArg) => PluginOptions[];
export type GetCustomPlugins = (arg: GetPluginsArg) => CustomPluginOptions[];
export type GetInternalPlugins = (arg: GetPluginsArg) => PluginOptions[];
export type GetWrappedPlugins = (arg: GetPluginsArg) => (PluginOptions | CustomPluginOptions)[];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

export type AuthOptions = {
    apiKey?: string;
    appKey?: string;
    site?: string;
};

export type AuthOptionsWithDefaults = WithRequired<AuthOptions, 'site'>;

export interface BaseOptions {
    auth?: AuthOptions;
    metadata?: BuildMetadata;
    enableGit?: boolean;
    logLevel?: LogLevel;
}

export interface Options extends BaseOptions {
    // Each product should have a unique entry.
    // #types-injection-marker
    [errorTracking.CONFIG_KEY]?: ErrorTrackingOptions;
    [metrics.CONFIG_KEY]?: MetricsOptions;
    [rum.CONFIG_KEY]?: RumOptions;
    // #types-injection-marker
    customPlugins?: GetCustomPlugins;
}

export type OptionsWithDefaults = Assign<
    Assign<Options, Required<BaseOptions>>,
    { auth: AuthOptionsWithDefaults }
>;

export type PluginName = `datadog-${Lowercase<string>}-plugin`;

type Data = { data?: BodyInit; headers?: Record<string, string> };
export type RequestOpts = {
    url: string;
    auth?: Pick<AuthOptions, 'apiKey' | 'appKey'>;
    method?: string;
    getData?: () => Promise<Data> | Data;
    type?: 'json' | 'text';
    onRetry?: (error: Error, attempt: number) => void;
    retries?: number;
    minTimeout?: number;
    maxTimeout?: number;
};

export type ResolvedEntry = { name?: string; resolved: string; original: string };

export interface LocalAppendOptions {
    contentType: string;
    filename: string;
}

export type FileValidity = {
    empty: boolean;
    exists: boolean;
};

export type GlobalData = {
    bundler: {
        name: BundlerName;
        version: string;
    };
    env: Env;
    metadata: BuildMetadata;
    packageName: string;
    version: string;
};

export type GlobalStores = {
    errors: string[];
    logs: Log[];
    queue: Promise<any>[];
    timings: Timer[];
    warnings: string[];
};

/* Legacy Telemetry types */
export type TAP_TYPES = 'default' | 'async' | 'promise';

export interface ValueContext {
    type: string;
    name: string;
    value?: string;
}

export interface Value {
    start: number;
    end: number;
    duration: number;
    context?: ValueContext[];
    type?: TAP_TYPES; // Only for webpack.
}

export interface Timing {
    name: string;
    duration: number;
    increment: number;
    events: {
        [key: string]: {
            name: string;
            values: Value[];
        };
    };
}
export type TimingsMap = Map<string, Timing>;

export interface TimingsReport {
    tapables?: TimingsMap;
    loaders?: TimingsMap;
    modules?: TimingsMap;
}

export interface Report {
    timings: TimingsReport;
}
