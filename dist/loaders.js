"use strict";
// Unless explicitly stated otherwise all files in this repository are licensed
// under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
Object.defineProperty(exports, "__esModule", { value: true });
const perf_hooks_1 = require("perf_hooks");
const helpers_1 = require("./helpers");
class Loaders {
    constructor() {
        this.started = {};
        this.finished = [];
    }
    buildModule(module, context) {
        const moduleName = helpers_1.getModuleName(module, context);
        const loaders = helpers_1.getLoaderNames(module);
        if (!loaders.length) {
            // Keep a track of modules without a loader.
            loaders.push('no-loader');
        }
        // Store the event until the module is complete.
        this.started[moduleName] = {
            module: helpers_1.getDisplayName(moduleName),
            timings: {
                start: perf_hooks_1.performance.now(),
            },
            loaders,
        };
    }
    succeedModule(module, context) {
        const moduleName = helpers_1.getModuleName(module, context);
        // Get the event for this module.
        const event = this.started[moduleName];
        if (!event) {
            return;
        }
        event.timings.end = perf_hooks_1.performance.now();
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
                modules[event.module].loaders.push(Object.assign({ name: event.loaders.join(',') }, event.timings));
            }
            else {
                modules[event.module] = {
                    name: event.module,
                    increment: 0,
                    duration: 0,
                    loaders: [
                        Object.assign({ name: event.loaders.join(',') }, event.timings),
                    ],
                };
            }
            modules[event.module].increment += 1;
            modules[event.module].duration += duration;
            // Aggregate loader timings
            for (const loader of event.loaders) {
                loaders[loader] = loaders[loader] || {
                    name: loader,
                    increment: 0,
                    duration: 0,
                };
                loaders[loader].increment += 1;
                loaders[loader].duration += duration;
            }
        }
        return { loaders, modules };
    }
}
exports.Loaders = Loaders;
