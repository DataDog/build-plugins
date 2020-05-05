export type HOOKS = 'output';
export type WRAPPED_HOOKS = 'preoutput' | 'output' | 'postoutput';

export interface LocalHook {
    hooks: {
        [key in WRAPPED_HOOKS]?: (context: any) => Promise<any> | any;
    };
}

export interface Options {
    disabled?: boolean;
    output?: boolean | string;
    hooks?: string[];
    datadog?: any;
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
    hooks: {
        buildModule: { tap(opts: any, callback: (module: any) => void): void };
        succeedModule: { tap(opts: any, callback: (module: any) => void): void };
        afterOptimizeTree: {
            tap(opts: any, callback: (chunks: any[], modules: any[]) => void): void;
        };
    };
}

export interface Stats {
    toJson(opts: { children: boolean }): any;
}

export interface Chunk {
    id: string;
    size: number;
    modules: any[];
    files: string[];
}

export interface StatsJson {
    entrypoints: {
        [key: string]: {
            chunks: string[];
        };
    };
    chunks: Chunk[];
}

export interface Hook {
    tap?: Tap;
    tapAsync?: TapAsync;
    tapPromise?: TapPromise;
}

export interface Tappable {
    constructor: { name: string };
    hooks: {
        [key: string]: Hook;
    };
}

export interface Compiler extends Tappable {
    hooks: {
        thisCompilation: { tap(opts: any, callback: (compilation: Compilation) => void): void };
        done: {
            tap(opts: any, callback: (stats: Stats) => void): void;
            tapPromise(opts: any, callback: (stats: Stats) => void): Promise<any>;
        };
    };
}

export type TAP_TYPES = 'default' | 'async' | 'promise';

export interface Report {
    timings: {
        tappables: TappableTimings;
        loaders: ResultLoaders;
        modules: ResultModules;
    };
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

export interface TappableTimings {
    [key: string]: {
        name: string;
        duration?: number;
        hooks: {
            [key: string]: {
                name: string;
                values: Value[];
            };
        };
    };
}

export interface MonitoredTaps {
    [key: string]: any;
}

export interface TappablesResult {
    monitoredTaps: MonitoredTaps;
    tappables: Tappable[];
    hooks: Hooks;
    timings: TappableTimings;
}

export type TapAsync = (...args: any[]) => void;
export type Tap = (...args: any[]) => any;
export type TapPromise = (...args: any[]) => Promise<any>;

export interface Hooks {
    [key: string]: string[];
}

export interface Module {
    name?: string;
    userRequest?: string;
    issuer?: {
        userRequest: string;
    };
    _identifier?: string;
    loaders: {
        loader: string;
    }[];
    dependencies: {
        module: Module;
    }[];
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
    dependencies: { module: Module }[];
    dependents: Set<string> | string[];
}

export interface LocalModules {
    [key: string]: LocalModule;
}

export interface ModulesResult {
    modules: LocalModules;
}
