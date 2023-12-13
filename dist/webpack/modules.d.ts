import { Module, LocalModule, ModulesResult, Compilation, Dependency, LocalOptions } from '../types';
export declare class Modules {
    constructor(options: LocalOptions);
    options: LocalOptions;
    storedModules: {
        [key: string]: LocalModule;
    };
    storedDependents: {
        [key: string]: Set<string>;
    };
    getModule(dep: Dependency, compilation: Compilation): Module | undefined;
    getChunks(module: Module, compilation: Compilation): Set<any>;
    getLocalModule(name: string, module: Module, compilation: Compilation, opts?: Partial<LocalModule>): LocalModule;
    afterOptimizeTree(chunks: any, modules: Module[], compilation: Compilation): void;
    getResults(): ModulesResult;
}
