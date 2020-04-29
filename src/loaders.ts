// Unless explicitly stated otherwise all files in this repository are licensed
// under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

const { performance } = require('perf_hooks');

const { getDisplayName, getModuleName, getLoaderNames } = require('./helpers');

class LoadersPlugin {
    started = {};
    finished = [];

    buildModule(module, context) {
        const moduleName = getModuleName(module, context);
        const loaders = getLoaderNames(module);

        if (!loaders.length) {
            // Keep a track of modules without a loader.
            loaders.push('no-loader');
        }

        // Store the event until the module is complete.
        this.started[moduleName] = {
            module: getDisplayName(moduleName),
            timings: {
                start: performance.now()
            },
            loaders
        };
    }

    succeedModule(module, context) {
        const moduleName = getModuleName(module, context);
        // Get the event for this module.
        const event = this.started[moduleName];

        if (!event) {
            return;
        }

        event.timings.end = performance.now();

        // Store the event.
        this.finished.push(event);

        // Delete the entry so another import
        // of the same module can be also reported.
        delete this.started[moduleName];
    }

    getResults() {
        const loaders = {};
        const modules = {};
        for (const event of this.finished) {
            const duration = event.timings.end - event.timings.start;

            // Aggregate module timings
            if (modules[event.module]) {
                modules[event.module].loaders.push({
                    name: event.loaders.join(','),
                    ...event.timings
                });
            } else {
                modules[event.module] = {
                    name: event.module,
                    increment: 0,
                    duration: 0,
                    loaders: [
                        {
                            name: event.loaders.join(','),
                            ...event.timings
                        }
                    ]
                };
            }

            modules[event.module].increment += 1;
            modules[event.module].duration += duration;

            // Aggregate loader timings
            for (const loader of event.loaders) {
                loaders[loader] = loaders[loader] || {
                    name: loader,
                    increment: 0,
                    duration: 0
                };
                loaders[loader].increment += 1;
                loaders[loader].duration += duration;
            }
        }

        return { loaders, modules };
    }
}

module.exports = LoadersPlugin;
