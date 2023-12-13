import { EsbuildStats, EsbuildIndexedObject } from '../../../types';
import { Metric } from '../types';
export declare const getInputsDependencies: (list: {
    [path: string]: {
        bytes: number;
        imports: {
            path: string;
            kind: import("esbuild").ImportKind;
        }[];
    };
}, moduleName: string, deps?: Set<string>) => Set<string>;
export declare const getIndexed: (stats: EsbuildStats, context: string) => EsbuildIndexedObject;
export declare const formatEntryTag: (entryName: string, context: string) => string;
export declare const getEntryTags: (module: string, indexed: EsbuildIndexedObject, context: string) => string[];
export declare const getModules: (stats: EsbuildStats, indexed: EsbuildIndexedObject, context: string) => Metric[];
export declare const getAssets: (stats: EsbuildStats, indexed: EsbuildIndexedObject, context: string) => Metric[];
export declare const getEntries: (stats: EsbuildStats, indexed: EsbuildIndexedObject, context: string) => Metric[];
