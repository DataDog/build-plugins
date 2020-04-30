export type HOOKS = 'output';
export type WRAPPED_HOOKS = 'preoutput' | 'output' | 'postoutput';

export interface LocalHook {
    hooks: {
        [key in WRAPPED_HOOKS]?: (context: any) => Promise<any>;
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

export interface Stats {}

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

export interface Result {
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
