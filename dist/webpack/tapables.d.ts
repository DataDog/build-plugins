import { MonitoredTaps, Tapable, Hooks, TimingsMap, Context, TAP_TYPES, TapablesResult, TapPromise, TapAsync, Tap, Hook, LocalOptions } from '../types';
export declare class Tapables {
    constructor(options: LocalOptions);
    options: LocalOptions;
    monitoredTaps: MonitoredTaps;
    tapables: Tapable[];
    hooks: Hooks;
    timings: TimingsMap;
    saveResult(type: TAP_TYPES, pluginName: string, hookName: string, context: Context[], start: number, end: number): void;
    getResults(): TapablesResult;
    getPromiseTapPatch(type: TAP_TYPES, fn: TapPromise, pluginName: string, hookName: string): (args_0: any) => Promise<any>;
    getAsyncTapPatch(type: TAP_TYPES, fn: TapAsync, pluginName: string, hookName: string): (args_0: any) => void;
    getDefaultTapPatch(type: TAP_TYPES, fn: Tap, pluginName: string, hookName: string): (args_0: any) => any;
    getTapPatch(type: TAP_TYPES, fn: (args: any) => any, pluginName: string, hookName: string): (args_0: any) => void;
    newTap(type: TAP_TYPES, hookName: string, originalTap: Tap | TapAsync | TapPromise, scope: any): (options: any, fn: (args: any) => any) => any;
    replaceTaps(hookName: string, hook: Hook): void;
    checkHooks(): void;
    throughHooks(tapable: Tapable): void;
}
