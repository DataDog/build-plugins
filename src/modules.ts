// Unless explicitly stated otherwise all files in this repository are licensed
// under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

const { getDisplayName, getModuleName } = require('./helpers');

class ModulesPlugin {
    storedModules = {};
    storedDependents = {};

    afterOptimizeTree(chunks, modules, context) {
        for (const module of modules) {
            const moduleName = getModuleName(module, context);
            let dependencies = module.dependencies
                // Ensure it's a module because webpack register as dependency
                // a lot of different stuff that is not modules.
                // RequireHeaderDependency, ConstDepependency, ...
                .filter(dep => dep.module)
                .map(dep => getModuleName(dep.module, context));

            // If we've already encounter this module, merge its dependencies.
            if (this.storedModules[moduleName]) {
                dependencies = [
                    ...dependencies,
                    ...this.storedModules[moduleName].dependencies
                ];
            }

            // Make dependencies unique and format their names.
            dependencies = [...new Set(dependencies)];

            this.storedModules[moduleName] = {
                name: getDisplayName(moduleName),
                dependencies,
                dependents: []
            };

            // Update the dependents store once we have all dependencies
            for (const dep of dependencies) {
                this.storedDependents[dep] =
                    this.storedDependents[dep] || new Set();
                if (!this.storedDependents[dep].has(moduleName)) {
                    this.storedDependents[dep].add(moduleName);
                }
            }
        }

        // Re-assign dependents to modules.
        for (const storedDepName in this.storedDependents) {
            if (
                Object.prototype.hasOwnProperty.call(
                    this.storedDependents,
                    storedDepName
                )
            ) {
                if (!this.storedModules[storedDepName]) {
                    this.storedModules[storedDepName] = {
                        name: storedDepName,
                        dependencies: []
                    };
                }
                // Assign dependents.
                this.storedModules[storedDepName].dependents = Array.from(
                    this.storedDependents[storedDepName]
                );
            }
        }
    }

    getResults() {
        return {
            modules: this.storedModules
        };
    }
}

module.exports = ModulesPlugin;
