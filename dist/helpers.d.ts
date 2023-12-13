import { Module, Compilation, Context } from './types';
export declare const getPluginName: (opts: string | {
    name: string;
}) => string;
export declare const formatContext: (context?: string) => string;
export declare const getDisplayName: (name: string, context?: string | undefined) => string;
export declare const formatModuleName: (name: string, context?: string | undefined) => string;
export declare const getModulePath: (module: Module, compilation: Compilation) => string;
export declare const getModuleName: (module: Module, compilation: Compilation, context?: string | undefined) => string;
export declare const getModuleSize: (module: Module) => number;
export declare const formatLoaderName: (loader: string) => string;
export declare const getLoaderNames: (module: Module) => string[];
export declare const formatDuration: (duration: number) => string;
export declare const writeFile: (filePath: string, content: any) => Promise<unknown>;
export declare const getContext: (args: any[]) => Context[];
