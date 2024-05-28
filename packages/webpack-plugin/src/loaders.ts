// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { performance } from 'perf_hooks';

import { getDisplayName, getModuleName, getLoaderNames } from '@datadog/build-plugins-core/helpers';
import {
    Module,
    Event,
    Timing,
    Compilation,
    TimingsMap,
    LocalOptions,
} from '@datadog/build-plugins-core/types';

export class Loaders {
    constructor(options: LocalOptions) {
        this.options = options;
    }
    options: LocalOptions;
    started: { [key: string]: Event } = {};
    finished: Event[] = [];

    buildModule(module: Module, compilation: Compilation): void {
        const context = this.options.context;
        const moduleName = getModuleName(module, compilation, context);
        const loaders = getLoaderNames(module);

        if (!loaders.length) {
            // Keep a track of modules without a loader.
            loaders.push('no-loader');
        }

        // Store the event until the module is complete.
        this.started[moduleName] = {
            module: getDisplayName(moduleName),
            timings: {
                start: performance.now(),
                duration: 0,
                end: 0,
            },
            loaders,
        };
    }

    succeedModule(module: Module, compilation: Compilation): void {
        const context = this.options.context;
        const moduleName = getModuleName(module, compilation, context);
        // Get the event for this module.
        const event = this.started[moduleName];

        if (!event) {
            return;
        }

        event.timings.end = performance.now();
        event.timings.duration = event.timings.end - event.timings.start;

        // Store the event.
        this.finished.push(event);

        // Delete the entry so another import
        // of the same module can be also reported.
        delete this.started[moduleName];
    }

    getResults(): {
        modules: TimingsMap;
        loaders: TimingsMap;
    } {
        const loaders: Map<string, Timing> = new Map();
        const modules: Map<string, Timing> = new Map();
        for (const event of this.finished) {
            const duration = event.timings.end! - event.timings.start;

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
