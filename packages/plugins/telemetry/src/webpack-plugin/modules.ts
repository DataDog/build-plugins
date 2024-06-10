// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getDisplayName, getModuleName, getModuleSize } from '../common/helpers';
import type {
    Module,
    LocalModule,
    ModulesResult,
    Compilation,
    Dependency,
    TelemetryOptions,
} from '../types';

export class Modules {
    constructor(cwd: string, options: TelemetryOptions) {
        this.options = options;
        this.cwd = cwd;
    }
    cwd: string;
    options: TelemetryOptions;
    storedModules: { [key: string]: LocalModule } = {};
    storedDependents: { [key: string]: Set<string> } = {};

    // In Webpack 5, using dep.module throws an error.
    // It's advised to use ModuleGraph API instead (not available in previous versions).
    getModule(dep: Dependency, compilation: Compilation): Module | undefined {
        try {
            return dep.module;
        } catch (e) {
            return compilation.moduleGraph?.getModule(dep);
        }
    }

    getChunks(module: Module, compilation: Compilation): Set<any> {
        return module._chunks || compilation.chunkGraph?.getModuleChunks(module);
    }

    getLocalModule(
        name: string,
        module: Module,
        compilation: Compilation,
        opts?: Partial<LocalModule>,
    ): LocalModule {
        const localModule: LocalModule = {
            name: getDisplayName(name),
            size: getModuleSize(module),
            chunkNames: Array.from(this.getChunks(module, compilation)).map((c) => c.name),
            dependencies: [],
            dependents: [],
            ...opts,
        };

        return localModule;
    }

    afterOptimizeTree(chunks: any, modules: Module[], compilation: Compilation) {
        const moduleMap: { [key: string]: Module } = {};

        for (const module of modules) {
            const moduleName = getModuleName(module, compilation, this.cwd);
            moduleMap[moduleName] = module;
            let dependencies = module.dependencies
                // Ensure it's a module because webpack register as dependency
                // a lot of different stuff that are not modules.
                // RequireHeaderDependency, ConstDepependency, ...
                .filter((dep) => this.getModule(dep, compilation))
                .map((dep) =>
                    getModuleName(this.getModule(dep, compilation)!, compilation, this.cwd),
                );

            // If we've already encounter this module, merge its dependencies.
            if (this.storedModules[moduleName]) {
                dependencies = [...dependencies, ...this.storedModules[moduleName].dependencies];
            }

            // Make dependencies unique and format their names.
            dependencies = [...new Set(dependencies)];

            this.storedModules[moduleName] = this.getLocalModule(moduleName, module, compilation, {
                dependencies,
            });

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
            if (Object.hasOwn(this.storedDependents, storedDepName)) {
                if (!this.storedModules[storedDepName]) {
                    this.storedModules[storedDepName] = this.getLocalModule(
                        storedDepName,
                        moduleMap[storedDepName],
                        compilation,
                    );
                }
                // Assign dependents.
                this.storedModules[storedDepName].dependents = Array.from(
                    this.storedDependents[storedDepName],
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
