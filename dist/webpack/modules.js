"use strict";
// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
Object.defineProperty(exports, "__esModule", { value: true });
const helpers_1 = require("../helpers");
class Modules {
    constructor(options) {
        this.storedModules = {};
        this.storedDependents = {};
        this.options = options;
    }
    // In Webpack 5, using dep.module throws an error.
    // It's advised to use ModuleGraph API instead (not available in previous versions).
    getModule(dep, compilation) {
        var _a;
        try {
            return dep.module;
        }
        catch (e) {
            return (_a = compilation.moduleGraph) === null || _a === void 0 ? void 0 : _a.getModule(dep);
        }
    }
    getChunks(module, compilation) {
        var _a;
        return module._chunks || ((_a = compilation.chunkGraph) === null || _a === void 0 ? void 0 : _a.getModuleChunks(module));
    }
    getLocalModule(name, module, compilation, opts) {
        const localModule = Object.assign({ name: helpers_1.getDisplayName(name), size: helpers_1.getModuleSize(module), chunkNames: Array.from(this.getChunks(module, compilation)).map((c) => c.name), dependencies: [], dependents: [] }, opts);
        return localModule;
    }
    afterOptimizeTree(chunks, modules, compilation) {
        const context = this.options.context;
        const moduleMap = {};
        for (const module of modules) {
            const moduleName = helpers_1.getModuleName(module, compilation, context);
            moduleMap[moduleName] = module;
            let dependencies = module.dependencies
                // Ensure it's a module because webpack register as dependency
                // a lot of different stuff that are not modules.
                // RequireHeaderDependency, ConstDepependency, ...
                .filter((dep) => this.getModule(dep, compilation))
                .map((dep) => helpers_1.getModuleName(this.getModule(dep, compilation), compilation, context));
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
            if (Object.prototype.hasOwnProperty.call(this.storedDependents, storedDepName)) {
                if (!this.storedModules[storedDepName]) {
                    this.storedModules[storedDepName] = this.getLocalModule(storedDepName, moduleMap[storedDepName], compilation);
                }
                // Assign dependents.
                this.storedModules[storedDepName].dependents = Array.from(this.storedDependents[storedDepName]);
            }
        }
    }
    getResults() {
        return {
            modules: this.storedModules,
        };
    }
}
exports.Modules = Modules;
