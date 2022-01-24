// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { Module, LocalModule, ModulesResult, Compilation, Dependency } from '../types';
import { getDisplayName, getModuleName, getModuleSize } from '../helpers';

export class Modules {
    storedModules: { [key: string]: LocalModule } = {};
    storedDependents: { [key: string]: Set<string> } = {};

    afterOptimizeTree(chunks: any, modules: Module[], context: string, compilation: Compilation) {
        const moduleMap: { [key: string]: Module } = {};

        // In Webpack 5, using dep.module throws an error.
        // It's advised to use ModuleGraph API instead (not available in previous versions).
        const getModule = (dep: Dependency): Module | undefined => {
            try {
                return dep.module;
            } catch (e) {
                return compilation.moduleGraph?.getModule(dep);
            }
        };

        const getChunks = (module: Module): Set<any> => {
            return module._chunks || compilation.chunkGraph?.getModuleChunks(module);
        };

        for (const module of modules) {
            const moduleName = getModuleName(module, context, compilation);
            moduleMap[moduleName] = module;
            let dependencies = module.dependencies
                // Ensure it's a module because webpack register as dependency
                // a lot of different stuff that are not modules.
                // RequireHeaderDependency, ConstDepependency, ...
                .filter(getModule)
                .map((dep) => getModuleName(getModule(dep)!, context, compilation));

            // If we've already encounter this module, merge its dependencies.
            if (this.storedModules[moduleName]) {
                dependencies = [...dependencies, ...this.storedModules[moduleName].dependencies];
            }

            // Make dependencies unique and format their names.
            dependencies = [...new Set(dependencies)];

            this.storedModules[moduleName] = {
                name: getDisplayName(moduleName),
                size: getModuleSize(module),
                chunkNames: Array.from(getChunks(module)).map((c) => c.name),
                dependencies,
                dependents: [],
            };

            // Update the dependents store once we have all dependencies
            for (const dep of dependencies) {
                this.storedDependents[dep] = this.storedDependents[dep] || new Set();
                if (!this.storedDependents[dep].has(moduleName)) {
                    this.storedDependents[dep].add(moduleName);
                }
            }
        }

        // Re-assign dependents to modules.
        for (const storedDepName in this.storedDependents) {
            if (Object.prototype.hasOwnProperty.call(this.storedDependents, storedDepName)) {
                if (!this.storedModules[storedDepName]) {
                    this.storedModules[storedDepName] = {
                        name: storedDepName,
                        size: getModuleSize(moduleMap[storedDepName]),
                        chunkNames: Array.from(getChunks(moduleMap[storedDepName])).map(
                            (c) => c.name
                        ),
                        dependencies: [],
                        dependents: [],
                    };
                }
                // Assign dependents.
                this.storedModules[storedDepName].dependents = Array.from(
                    this.storedDependents[storedDepName]
                );
            }
        }
    }

    getResults(): ModulesResult {
        return {
            modules: this.storedModules,
        };
    }
}
