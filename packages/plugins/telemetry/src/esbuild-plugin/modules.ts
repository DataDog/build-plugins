// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { Metafile } from 'esbuild';

import { formatModuleName, getDisplayName } from '../common/helpers';
import type { LocalModule } from '../types';

const modulesMap: { [key: string]: LocalModule } = {};

const getDefaultLocalModule = (name: string): LocalModule => ({
    name: getDisplayName(name),
    chunkNames: [],
    size: 0,
    dependencies: [],
    dependents: [],
});

export const getModulesResults = (cwd: string, esbuildMeta?: Metafile) => {
    if (!esbuildMeta) {
        return {};
    }

    // Indexing chunks so we can access them faster.
    const outputs = esbuildMeta.outputs;
    const chunkIndexed: Record<string, Set<string>> = {};
    const parseModules = (chunkName: string, moduleName: string) => {
        const formatedModuleName = formatModuleName(moduleName, cwd);
        chunkIndexed[formatedModuleName] = chunkIndexed[formatedModuleName] || new Set();
        const formatedChunkName = chunkName.split('/').pop()?.split('.').shift() || 'unknown';
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
        const moduleName = formatModuleName(path, cwd);
        const module: LocalModule = modulesMap[moduleName] || getDefaultLocalModule(moduleName);

        module.size = obj.bytes;
        if (chunkIndexed[moduleName]) {
            module.chunkNames = Array.from(chunkIndexed[moduleName]);
        }

        for (const dependency of obj.imports) {
            const depName = formatModuleName(dependency.path, cwd);
            module.dependencies.push(depName);
            const depObj: LocalModule = modulesMap[depName] || getDefaultLocalModule(depName);
            depObj.dependents.push(moduleName);
            modulesMap[depName] = depObj;
        }

        modulesMap[moduleName] = module;
    }
    return modulesMap;
};
