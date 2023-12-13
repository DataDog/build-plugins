"use strict";
// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
Object.defineProperty(exports, "__esModule", { value: true });
const helpers_1 = require("../helpers");
const modulesMap = {};
const getDefaultLocalModule = (name) => ({
    name: helpers_1.getDisplayName(name),
    chunkNames: [],
    size: 0,
    dependencies: [],
    dependents: [],
});
exports.getModulesResults = (options, esbuildMeta) => {
    const context = options.context;
    if (!esbuildMeta) {
        return {};
    }
    // Indexing chunks so we can access them faster.
    const outputs = esbuildMeta.outputs;
    const chunkIndexed = {};
    const parseModules = (chunkName, moduleName) => {
        var _a;
        const formatedModuleName = helpers_1.formatModuleName(moduleName, context);
        chunkIndexed[formatedModuleName] = chunkIndexed[formatedModuleName] || new Set();
        const formatedChunkName = ((_a = chunkName.split('/').pop()) === null || _a === void 0 ? void 0 : _a.split('.').shift()) || 'unknown';
        chunkIndexed[formatedModuleName].add(formatedChunkName);
        if (outputs[moduleName] && outputs[moduleName].inputs.length) {
            for (const inputModuleName of Object.keys(outputs[moduleName].inputs)) {
                parseModules(moduleName, inputModuleName);
            }
        }
    };
    for (const [chunkName, chunk] of Object.entries(outputs)) {
        for (const moduleName of Object.keys(chunk.inputs)) {
            parseModules(chunkName, moduleName);
        }
    }
    for (const [path, obj] of Object.entries(esbuildMeta.inputs)) {
        const moduleName = helpers_1.formatModuleName(path, context);
        const module = modulesMap[moduleName] || getDefaultLocalModule(moduleName);
        module.size = obj.bytes;
        if (chunkIndexed[moduleName]) {
            module.chunkNames = Array.from(chunkIndexed[moduleName]);
        }
        for (const dependency of obj.imports) {
            const depName = helpers_1.formatModuleName(dependency.path, context);
            module.dependencies.push(depName);
            const depObj = modulesMap[depName] || getDefaultLocalModule(depName);
            depObj.dependents.push(moduleName);
            modulesMap[depName] = depObj;
        }
        modulesMap[moduleName] = module;
    }
    return modulesMap;
};
