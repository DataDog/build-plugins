// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { TimingsMap, Value, Metric } from '@dd/core/types';

export type Filter = (metric: Metric) => Metric | null;

export type MetricsOptions = {
    enable?: boolean;
    enableDefaultPrefix?: boolean;
    /** @deprecated */
    enableTracing?: boolean;
    filters?: Filter[];
    prefix?: string;
    tags?: string[];
    timestamp?: number;
};

export type MetricsOptionsWithDefaults = Required<MetricsOptions>;

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
        failedModule: { tap(opts: any, callback: (module: any, error: any) => void): void };
        afterOptimizeTree: {
            tap(opts: any, callback: (chunks: any[], modules: any[]) => void): void;
        };
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

export interface Hook {
    tap?: Tap;
    tapAsync?: TapAsync;
    tapPromise?: TapPromise;
    _fakeHook?: boolean;
}

export interface Tapable {
    constructor: { name: string };
    hooks: {
        [key: string]: Hook;
    };
}

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
