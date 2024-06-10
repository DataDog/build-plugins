// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { GetPluginsOptions } from '@dd/core/types';
import type { Metafile, Message, BuildOptions, BuildResult } from 'esbuild';

import type { CONFIG_KEY } from './constants';

export interface MetricToSend {
    type: 'gauge';
    tags: string[];
    metric: string;
    points: [number, number][];
}

export interface OptionsDD {
    tags: string[];
    prefix: string;
    timestamp: number;
    filters: Filter[];
}

export interface Metric {
    metric: string;
    type: 'count' | 'size' | 'duration';
    value: number;
    tags: string[];
}

export type Filter = (metric: Metric) => Metric | null;

export type OutputOptions =
    | boolean
    | string
    | {
          destination: string;
          timings?: boolean;
          dependencies?: boolean;
          bundler?: boolean;
          metrics?: boolean;
          logs?: boolean;
      };

export type TelemetryOptions = {
    disabled?: boolean;
    output?: OutputOptions;
    prefix?: string;
    tags?: string[];
    timestamp?: number;
    filters?: Filter[];
};

export interface OptionsWithTelemetry extends GetPluginsOptions {
    [CONFIG_KEY]: TelemetryOptions;
}

interface EsbuildBundlerResult extends Metafile {
    warnings: BuildResult['warnings'];
    errors: BuildResult['errors'];
    entrypoints: BuildOptions['entryPoints'];
    duration: number;
}

export type BundlerContext = {
    start: number;
    report: Report;
    metrics?: MetricToSend[];
    bundler: {
        esbuild?: EsbuildBundlerResult;
        webpack?: Stats;
    };
};

export interface EsbuildIndexedObject {
    entryNames: Map<string, string>;
    inputsDependencies: { [key: string]: Set<string> };
    outputsDependencies: { [key: string]: Set<string> };
}

export interface WebpackIndexedObject {
    modulesPerName: { [key: string]: Module };
    chunksPerId: { [key: string]: Chunk };
    entriesPerChunkId: { [key: string]: Entry };
}

export interface ModuleGraph {
    getModule(dependency: Dependency): Module;
    getIssuer(module: Module): Module;
    issuer: Module;
}

export interface Compilation {
    options: {
        context: string;
    };
    moduleGraph?: ModuleGraph;
    chunkGraph?: { getModuleChunks: (module: any) => Set<Chunk> };
    hooks: {
        buildModule: { tap(opts: any, callback: (module: any) => void): void };
        succeedModule: { tap(opts: any, callback: (module: any) => void): void };
        afterOptimizeTree: {
            tap(opts: any, callback: (chunks: any[], modules: any[]) => void): void;
        };
    };
}

export interface Stats {
    toJson(opts: { children: boolean }): StatsJson;
    endTime: number;
    startTime: number;
    compilation: {
        assets: { [key: string]: { size: number } };
        fileDependencies: Set<any>;
        emittedAssets: Set<any>;
        warnings: string[];
        modules: Set<Module> | Module[];
        chunks: Set<Chunk> | Chunk[];
        entries: any[] | Map<string, any>;
    };
}

export interface Chunk {
    id: string;
    size: number;
    modules: any[];
    files: string[];
    names: string[];
    parents: string[];
}

export interface Asset {
    name: string;
    size: number;
    chunks: string[];
}

export interface Entry {
    name: string;
    chunks: string[];
}

export interface Entries {
    [key: string]: Entry;
}

export interface StatsJson {
    entrypoints: {
        [key: string]: Entry;
    };
    chunks: Chunk[];
    modules: Module[];
    assets: Asset[];
    warnings: string[];
    errors: string[];
    time: number;
}

export interface Hook {
    tap?: Tap;
    tapAsync?: TapAsync;
    tapPromise?: TapPromise;
}

export interface Tapable {
    constructor: { name: string };
    hooks: {
        [key: string]: Hook;
    };
}

export interface Compiler extends Tapable {
    options: {};
    hooks: {
        thisCompilation: { tap(opts: any, callback: (compilation: Compilation) => void): void };
        done: {
            tap(opts: any, callback: (stats: Stats) => void): void;
            tapPromise(opts: any, callback: (stats: Stats) => void): Promise<any>;
        };
    };
}

export type TAP_TYPES = 'default' | 'async' | 'promise';

export interface TimingsReport {
    tapables?: TimingsMap;
    loaders?: TimingsMap;
    modules?: TimingsMap;
}

export interface Report {
    timings: TimingsReport;
    dependencies: LocalModules;
}

export interface EsbuildStats extends Metafile {
    warnings: Message[];
    errors: Message[];
    entrypoints: BuildOptions['entryPoints'];
    duration: number;
}

export interface BundlerStats {
    webpack?: Stats;
    esbuild?: EsbuildStats;
}

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

export interface MonitoredTaps {
    [key: string]: any;
}

export interface TapablesResult {
    monitoredTaps: MonitoredTaps;
    tapables: Tapable[];
    hooks: Hooks;
    timings: TimingsMap;
}

export type TapAsync = (...args: any[]) => void;
export type Tap = (...args: any[]) => any;
export type TapPromise = (...args: any[]) => Promise<any>;

export interface Hooks {
    [key: string]: string[];
}

export interface Dependency {
    module: Module;
}

export interface Module {
    name: string;
    userRequest: string;
    issuer?: {
        userRequest: string;
    };
    _identifier?: string;
    identifier?: string;
    modules?: Module[];
    moduleGraph?: ModuleGraph;
    size: (() => number) | number;
    loaders: {
        loader: string;
    }[];
    chunks: string[];
    _chunks: Set<Chunk>;
    dependencies: Dependency[];
}

export interface Event {
    module: string;
    timings: Value;
    loaders: string[];
}

export interface LocalModule {
    name: string;
    size: number;
    chunkNames: string[];
    dependencies: string[];
    dependents: string[];
}

export interface LocalModules {
    [key: string]: LocalModule;
}

export interface ModulesResult {
    modules: LocalModules;
}
