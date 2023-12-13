import { Chunk, StatsJson, Module, WebpackIndexedObject } from '../../../types';
import { Metric } from '../types';
export declare const getFromId: (coll: any[], id: string) => any;
export declare const foundInModules: (input: {
    modules?: Module[] | undefined;
}, identifier?: string | undefined) => boolean;
export declare const computeEntriesFromChunk: (chunk: Chunk, indexed: WebpackIndexedObject, parentEntries?: Set<string>, parentChunks?: Set<string>) => Set<string>;
export declare const getEntryTags: (entries: Set<string>) => string[];
export declare const getChunkTags: (chunks: Chunk[]) => string[];
export declare const getChunksFromModule: (stats: StatsJson, chunksPerId: {
    [key: string]: Chunk;
}, module: Module) => Chunk[];
export declare const getModules: (stats: StatsJson, indexed: WebpackIndexedObject, context: string) => Metric[];
export declare const getChunks: (stats: StatsJson, indexed: WebpackIndexedObject) => Metric[];
export declare const getAssets: (stats: StatsJson, indexed: WebpackIndexedObject) => Metric[];
export declare const getEntries: (stats: StatsJson, indexed: WebpackIndexedObject) => Metric[];
export declare const getIndexed: (stats: StatsJson, context: string) => WebpackIndexedObject;
