// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Metafile, Message, BuildOptions } from 'esbuild';
import type { UnpluginOptions } from 'unplugin';

export type HOOKS = 'output';
export type WRAPPED_HOOKS = 'preoutput' | 'output' | 'postoutput';

export interface LocalHook {
    hooks: {
        [key in WRAPPED_HOOKS]?: (context: any) => Promise<any> | any;
    };
}

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

export interface Context {
    type: string;
    name: string;
    value?: string;
}

export interface Value {
    start: number;
    end: number;
    duration: number;
    context?: Context[];
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

export type GetPlugins<T> = (options: T) => UnpluginOptions[];

export interface GetPluginsOptions {
    auth: {
        apiKey: string;
        appKey: string;
    };
}

export interface GetPluginsOptionsWithCWD extends GetPluginsOptions {
    cwd: string;
}
