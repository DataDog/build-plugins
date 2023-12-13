"use strict";
// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
Object.defineProperty(exports, "__esModule", { value: true });
const helpers_1 = require("../helpers");
const helpers_2 = require("../../../helpers");
exports.getFromId = (coll, id) => coll.find((c) => c.id === id);
exports.foundInModules = (input, identifier) => {
    if (!identifier || !input.modules || !input.modules.length) {
        return false;
    }
    return !!input.modules.find((m) => {
        if (m.identifier && m.identifier === identifier) {
            return true;
            // eslint-disable-next-line no-underscore-dangle
        }
        else if (m._identifier && m._identifier === identifier) {
            return true;
        }
        if (m.modules && m.modules.length) {
            return exports.foundInModules(m, identifier);
        }
    });
};
exports.computeEntriesFromChunk = (chunk, indexed, parentEntries = new Set(), parentChunks = new Set()) => {
    const entry = indexed.entriesPerChunkId[chunk.id];
    if (entry) {
        parentEntries.add(entry.name);
    }
    // Escape cyclic dependencies.
    if (parentChunks.has(chunk.id)) {
        return parentEntries;
    }
    parentChunks.add(chunk.id);
    chunk.parents.forEach((p) => {
        const parentChunk = indexed.chunksPerId[p];
        if (parentChunk) {
            exports.computeEntriesFromChunk(parentChunk, indexed, parentEntries, parentChunks);
        }
    });
    return parentEntries;
};
exports.getEntryTags = (entries) => Array.from(entries).map((e) => `entryName:${e}`);
exports.getChunkTags = (chunks) => helpers_1.flattened(chunks
    .map((c) => {
    if (c.names && c.names.length) {
        return c.names.map((n) => `chunkName:${n}`);
    }
})
    .filter((c) => c));
exports.getChunksFromModule = (stats, chunksPerId, module) => {
    if (module.chunks.length) {
        return module.chunks.map((c) => chunksPerId[c]);
    }
    // Find the chunks from the chunk list directly.
    // Webpack may not have registered module's chunks in some cases.
    // eslint-disable-next-line no-underscore-dangle
    return stats.chunks.filter((c) => exports.foundInModules(c, module.identifier || module._identifier));
};
const getMetricsFromModule = (stats, indexed, context, module) => {
    const chunks = exports.getChunksFromModule(stats, indexed.chunksPerId, module);
    const entries = new Set();
    for (const chunk of chunks) {
        exports.computeEntriesFromChunk(chunk, indexed, entries);
    }
    const chunkTags = exports.getChunkTags(chunks);
    const entryTags = exports.getEntryTags(entries);
    const moduleName = helpers_2.getDisplayName(module.name, context);
    return [
        {
            metric: 'modules.size',
            type: 'size',
            value: module.size,
            tags: [
                `moduleName:${moduleName}`,
                `moduleType:${helpers_1.getType(moduleName)}`,
                ...entryTags,
                ...chunkTags,
            ],
        },
    ];
};
exports.getModules = (stats, indexed, context) => {
    return helpers_1.flattened(Object.values(indexed.modulesPerName).map((module) => {
        return getMetricsFromModule(stats, indexed, context, module);
    }));
};
// Find in entries.chunks
exports.getChunks = (stats, indexed) => {
    const chunks = stats.chunks;
    return helpers_1.flattened(chunks.map((chunk) => {
        const entryTags = exports.getEntryTags(exports.computeEntriesFromChunk(chunk, indexed));
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
    }));
};
exports.getAssets = (stats, indexed) => {
    const assets = stats.assets;
    return assets.map((asset) => {
        const chunks = asset.chunks.map((c) => indexed.chunksPerId[c]);
        const entries = new Set();
        for (const chunk of chunks) {
            exports.computeEntriesFromChunk(chunk, indexed, entries);
        }
        const chunkTags = exports.getChunkTags(chunks);
        const entryTags = exports.getEntryTags(entries);
        const assetName = asset.name;
        return {
            metric: 'assets.size',
            type: 'size',
            value: asset.size,
            tags: [
                `assetName:${assetName}`,
                `assetType:${helpers_1.getType(assetName)}`,
                ...chunkTags,
                ...entryTags,
            ],
        };
    });
};
exports.getEntries = (stats, indexed) => helpers_1.flattened(Object.keys(stats.entrypoints).map((entryName) => {
    const entry = stats.entrypoints[entryName];
    const chunks = entry.chunks.map((chunkId) => indexed.chunksPerId[chunkId]);
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
}));
exports.getIndexed = (stats, context) => {
    // Gather all modules.
    const modulesPerName = {};
    const chunksPerId = {};
    const entriesPerChunkId = {};
    const addModule = (module) => {
        // console.log('Add Module', module.name);
        // No internals.
        if (/^webpack\/runtime/.test(module.name)) {
            return;
        }
        // No duplicates.
        if (modulesPerName[helpers_2.formatModuleName(module.name, context)]) {
            return;
        }
        // Modules are sometimes registered with their loader.
        if (module.name.includes('!')) {
            return;
        }
        modulesPerName[helpers_2.formatModuleName(module.name, context)] = module;
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
        }
        else {
            addModule(module);
        }
    }
    return {
        modulesPerName,
        chunksPerId,
        entriesPerChunkId,
    };
};
