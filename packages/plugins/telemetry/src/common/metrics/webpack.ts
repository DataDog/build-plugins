// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { formatModuleName, getDisplayName } from '@dd/core/helpers';
import type { Chunk, StatsJson, Module, Entry, WebpackIndexedObject } from '@dd/core/types';

import type { Metric } from '../../types';
import { flattened, getType } from '../helpers';

export const getFromId = (coll: any[], id: string) => coll.find((c) => c.id === id);

export const foundInModules = (input: { modules?: Module[] }, identifier?: string): boolean => {
    if (!identifier || !input.modules || !input.modules.length) {
        return false;
    }

    return !!input.modules.find((m) => {
        if (m.identifier && m.identifier === identifier) {
            return true;
            // eslint-disable-next-line no-underscore-dangle
        } else if (m._identifier && m._identifier === identifier) {
            return true;
        }

        if (m.modules && m.modules.length) {
            return foundInModules(m, identifier);
        }
    });
};

export const computeEntriesFromChunk = (
    chunk: Chunk,
    indexed: WebpackIndexedObject,
    parentEntries: Set<string> = new Set(),
    parentChunks: Set<string> = new Set(),
): Set<string> => {
    const entry = indexed.entriesPerChunkId[chunk.id];

    if (entry) {
        parentEntries.add(entry.name);
    }

    // Escape cyclic dependencies.
    if (parentChunks.has(chunk.id)) {
        return parentEntries;
    }

    parentChunks.add(chunk.id);
    chunk.parents.forEach((p: string) => {
        const parentChunk = indexed.chunksPerId[p];
        if (parentChunk) {
            computeEntriesFromChunk(parentChunk, indexed, parentEntries, parentChunks);
        }
    });
    return parentEntries;
};

export const getEntryTags = (entries: Set<string>): string[] =>
    Array.from(entries).map((e) => `entryName:${e}`);

export const getChunkTags = (chunks: Chunk[]): string[] =>
    flattened(
        chunks
            .map((c) => {
                if (c.names && c.names.length) {
                    return c.names.map((n) => `chunkName:${n}`);
                }
            })
            .filter((c) => c),
    );

export const getChunksFromModule = (
    stats: StatsJson,
    chunksPerId: { [key: string]: Chunk },
    module: Module,
) => {
    if (module.chunks.length) {
        return module.chunks.map((c) => chunksPerId[c]);
    }

    // Find the chunks from the chunk list directly.
    // Webpack may not have registered module's chunks in some cases.
    // eslint-disable-next-line no-underscore-dangle
    return stats.chunks.filter((c) => foundInModules(c, module.identifier || module._identifier));
};

const getMetricsFromModule = (
    stats: StatsJson,
    indexed: WebpackIndexedObject,
    cwd: string,
    module: Module,
) => {
    const chunks = getChunksFromModule(stats, indexed.chunksPerId, module);
    const entries: Set<string> = new Set();
    for (const chunk of chunks) {
        computeEntriesFromChunk(chunk, indexed, entries);
    }
    const chunkTags = getChunkTags(chunks);
    const entryTags = getEntryTags(entries);
    const moduleName = getDisplayName(module.name, cwd);

    return [
        {
            metric: 'modules.size',
            type: 'size',
            value: module.size,
            tags: [
                `moduleName:${moduleName}`,
                `moduleType:${getType(moduleName)}`,
                ...entryTags,
                ...chunkTags,
            ],
        },
    ];
};

export const getModules = (
    stats: StatsJson,
    indexed: WebpackIndexedObject,
    cwd: string,
): Metric[] => {
    return flattened(
        Object.values(indexed.modulesPerName).map((module) => {
            return getMetricsFromModule(stats, indexed, cwd, module);
        }),
    );
};

// Find in entries.chunks
export const getChunks = (stats: StatsJson, indexed: WebpackIndexedObject): Metric[] => {
    const chunks = stats.chunks;

    return flattened(
        chunks.map((chunk) => {
            const entryTags = getEntryTags(computeEntriesFromChunk(chunk, indexed));
            const chunkName = chunk.names.length ? chunk.names.join(' ') : chunk.id;

            return [
                {
                    metric: 'chunks.size',
                    type: 'size',
                    value: chunk.size,
                    tags: [`chunkName:${chunkName}`, ...entryTags],
                },
                {
                    metric: 'chunks.modules.count',
                    type: 'count',
                    value: chunk.modules.length,
                    tags: [`chunkName:${chunkName}`, ...entryTags],
                },
            ];
        }),
    );
};

export const getAssets = (stats: StatsJson, indexed: WebpackIndexedObject): Metric[] => {
    const assets = stats.assets;
    return assets.map((asset) => {
        const chunks = asset.chunks.map((c) => indexed.chunksPerId[c]);
        const entries: Set<string> = new Set();
        for (const chunk of chunks) {
            computeEntriesFromChunk(chunk, indexed, entries);
        }
        const chunkTags = getChunkTags(chunks);
        const entryTags = getEntryTags(entries);
        const assetName = asset.name;

        return {
            metric: 'assets.size',
            type: 'size',
            value: asset.size,
            tags: [
                `assetName:${assetName}`,
                `assetType:${getType(assetName)}`,
                ...chunkTags,
                ...entryTags,
            ],
        };
    });
};

export const getEntries = (stats: StatsJson, indexed: WebpackIndexedObject): Metric[] =>
    flattened(
        Object.keys(stats.entrypoints).map((entryName) => {
            const entry = stats.entrypoints[entryName];
            const chunks = entry.chunks.map((chunkId) => indexed.chunksPerId[chunkId]!);

            let size = 0;
            let moduleCount = 0;
            let assetsCount = 0;

            for (const chunk of chunks) {
                size += chunk.size;
                moduleCount += chunk.modules.length;
                assetsCount += chunk.files.length;
            }

            return [
                {
                    metric: 'entries.size',
                    type: 'size',
                    value: size,
                    tags: [`entryName:${entryName}`],
                },
                {
                    metric: 'entries.chunks.count',
                    type: 'count',
                    value: chunks.length,
                    tags: [`entryName:${entryName}`],
                },
                {
                    metric: 'entries.modules.count',
                    type: 'count',
                    value: moduleCount,
                    tags: [`entryName:${entryName}`],
                },
                {
                    metric: 'entries.assets.count',
                    type: 'count',
                    value: assetsCount,
                    tags: [`entryName:${entryName}`],
                },
            ];
        }),
    );

export const getIndexed = (stats: StatsJson, cwd: string): WebpackIndexedObject => {
    // Gather all modules.
    const modulesPerName: { [key: string]: Module } = {};
    const chunksPerId: { [key: string]: Chunk } = {};
    const entriesPerChunkId: { [key: string]: Entry } = {};

    const addModule = (module: Module) => {
        // No internals.
        if (/^webpack\/runtime/.test(module.name)) {
            return;
        }
        // No duplicates.
        if (modulesPerName[formatModuleName(module.name, cwd)]) {
            return;
        }
        // Modules are sometimes registered with their loader.
        if (module.name.includes('!')) {
            return;
        }

        modulesPerName[formatModuleName(module.name, cwd)] = module;
    };

    for (const [name, entry] of Object.entries(stats.entrypoints)) {
        // In webpack4 we don't have the name of the entry here.
        entry.name = name;
        for (const chunkId of entry.chunks) {
            entriesPerChunkId[chunkId] = entry;
        }
    }

    for (const chunk of stats.chunks) {
        chunksPerId[chunk.id] = chunk;
    }

    for (const module of stats.modules) {
        // Sometimes modules are grouped together.
        if (module.modules && module.modules.length) {
            for (const moduleIn of module.modules) {
                addModule(moduleIn);
            }
        } else {
            addModule(module);
        }
    }

    return {
        modulesPerName,
        chunksPerId,
        entriesPerChunkId,
    };
};
