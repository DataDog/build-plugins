// Unless explicitly stated otherwise all files in this repository are licensed
// under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

export type HOOKS = 'output';
export type WRAPPED_HOOKS = 'preoutput' | 'output' | 'postoutput';

export interface LocalHook {
    hooks: {
        [key in WRAPPED_HOOKS]?: (context: any) => Promise<any> | any;
    };
}

export interface ModuleGraph {
    getModule(dependency: Dependency): Module;
    issuer: Module;
}

export interface Options {
    disabled?: boolean;
    output?: boolean | string;
    hooks?: string[];
    datadog?: any;
    context?: string;
}

export interface LocalOptions {
    disabled?: boolean;
    output?: boolean | string;
    context?: string;
    datadog: any;
}

export interface Compilation {
    options: {
        context: string;
    };
    moduleGraph?: ModuleGraph;
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
        modules: Set<Module> & Module[];
        chunks: Set<Chunk> & Chunk[];
        entries: any[] & Map<string, any>;
    };
}

export interface Chunk {
    id: string;
    size: number;
    modules: any[];
    files: string[];
    names: string[];
}

export interface Asset {
    name: string;
    size: number;
}

export interface StatsJson {
    entrypoints: {
        [key: string]: {
            chunks: string[];
        };
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
    tapables: TapableTimings;
    loaders: ResultLoaders;
    modules: ResultModules;
}

export interface Report {
    timings: TimingsReport;
    dependencies: LocalModules;
}

export interface HooksContext {
    start: number;
    report: Report;
    stats: Stats;
    [key: string]: any;
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
    context: Context[];
    type: TAP_TYPES;
}

export interface TapableTiming {
    name: string;
    duration?: number;
    hooks: {
        [key: string]: {
            name: string;
            values: Value[];
        };
    };
}

export interface TapableTimings {
    [key: string]: TapableTiming;
}

export interface MonitoredTaps {
    [key: string]: any;
}

export interface TapablesResult {
    monitoredTaps: MonitoredTaps;
    tapables: Tapable[];
    hooks: Hooks;
    timings: TapableTimings;
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
    userRequest?: string;
    issuer?: {
        userRequest: string;
    };
    _identifier?: string;
    moduleGraph?: ModuleGraph;
    size: number;
    loaders: {
        loader: string;
    }[];
    dependencies: Dependency[];
}

export interface Event {
    module: string;
    timings: { start: number; end?: number };
    loaders: string[];
}

export interface ResultModuleEvent {
    name: string;
    start: number;
    end?: number;
}

export interface ResultModule {
    name: string;
    increment: number;
    duration: number;
    loaders: ResultModuleEvent[];
}

export interface ResultLoader {
    name: string;
    increment: number;
    duration: number;
}

export interface ResultModules {
    [key: string]: ResultModule;
}
export interface ResultLoaders {
    [key: string]: ResultLoader;
}

export interface LoadersResult {
    modules: ResultModules;
    loaders: ResultLoaders;
}

export interface LocalModule {
    name: string;
    dependencies: string[];
    dependents: string[];
}

export interface LocalModules {
    [key: string]: LocalModule;
}

export interface ModulesResult {
    modules: LocalModules;
}
