"use strict";
// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const perf_hooks_1 = require("perf_hooks");
const helpers_1 = require("../helpers");
const dd_trace_1 = __importDefault(require("dd-trace"));
class Loaders {
    constructor(options) {
        this.started = {};
        this.finished = [];
        this.traces = new WeakMap();
        this.options = options;
    }
    buildModule(module, compilation) {
        const context = this.options.context;
        const moduleName = helpers_1.getModuleName(module, compilation, context);
        const loaders = helpers_1.getLoaderNames(module);
        const span = dd_trace_1.default.startSpan(`module.${helpers_1.getModuleName(module, compilation, context)}`, {
            tags: {
                loaders,
            },
        });
        this.traces.set(module, span);
        if (!loaders.length) {
            // Keep a track of modules without a loader.
            loaders.push('no-loader');
        }
        // Store the event until the module is complete.
        this.started[moduleName] = {
            module: helpers_1.getDisplayName(moduleName),
            timings: {
                start: perf_hooks_1.performance.now(),
                duration: 0,
                end: 0,
            },
            loaders,
        };
    }
    succeedModule(module, compilation) {
        const context = this.options.context;
        const moduleName = helpers_1.getModuleName(module, compilation, context);
        // Get the event for this module.
        const event = this.started[moduleName];
        if (!event) {
            return;
        }
        event.timings.end = perf_hooks_1.performance.now();
        event.timings.duration = event.timings.end - event.timings.start;
        // Store the event.
        this.finished.push(event);
        // Delete the entry so another import
        // of the same module can be also reported.
        delete this.started[moduleName];
        const span = this.traces.get(module);
        if (span) {
            span.finish();
            this.traces.delete(module);
        }
    }
    getResults() {
        const loaders = new Map();
        const modules = new Map();
        for (const event of this.finished) {
            const duration = event.timings.end - event.timings.start;
            // Aggregate module timings
            const moduleTiming = modules.get(event.module) || {
                name: event.module,
                increment: 0,
                duration: 0,
                events: {},
            };
            const eventName = event.loaders.join(',');
            moduleTiming.events[eventName] = moduleTiming.events[eventName] || {
                name: eventName,
                values: [],
            };
            moduleTiming.events[eventName].values.push(event.timings);
            moduleTiming.increment += 1;
            moduleTiming.duration += duration;
            modules.set(event.module, moduleTiming);
            // Aggregate loader timings
            for (const loader of event.loaders) {
                const loaderTiming = loaders.get(loader) || {
                    name: loader,
                    increment: 0,
                    duration: 0,
                    events: {},
                };
                loaderTiming.increment += 1;
                loaderTiming.duration += duration;
                loaders.set(loader, loaderTiming);
            }
        }
        return { loaders, modules };
    }
}
exports.Loaders = Loaders;
