// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Assign } from '@dd/core/types';

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

export type MetricsOptions = {
    enable?: boolean;
    enableStaticPrefix?: boolean;
    /** @deprecated */
    enableTracing?: boolean;
    filters?: Filter[];
    prefix?: string;
    tags?: string[];
    timestamp?: number;
};

export type MetricsOptionsWithDefaults = Assign<
    Required<MetricsOptions>,
    {
        timestamp?: MetricsOptions['timestamp'];
    }
>;

export interface TimingsReport {
    tapables?: TimingsMap;
    loaders?: TimingsMap;
    modules?: TimingsMap;
}

export interface Report {
    timings: TimingsReport;
}

export type BundlerContext = {
    start: number;
    report?: Report;
};

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
