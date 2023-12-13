import { Module, Event, Compilation, TimingsMap, LocalOptions } from '../types';
import type { Span } from 'dd-trace';
export declare class Loaders {
    constructor(options: LocalOptions);
    options: LocalOptions;
    started: {
        [key: string]: Event;
    };
    finished: Event[];
    traces: WeakMap<Module, Span>;
    buildModule(module: Module, compilation: Compilation): void;
    succeedModule(module: Module, compilation: Compilation): void;
    getResults(): {
        modules: TimingsMap;
        loaders: TimingsMap;
    };
}
