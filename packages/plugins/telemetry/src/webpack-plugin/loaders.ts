// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import type { TimingsMap, Timing } from '@dd/core/types';
import { getDisplayName, getModuleName, getLoaderNames } from '@dd/telemetry-plugin/common/helpers';
import type { Module, Event, Compilation } from '@dd/telemetry-plugin/types';
import { performance } from 'perf_hooks';

export class Loaders {
    constructor(cwd: string) {
        this.cwd = cwd;
    }
    cwd: string;
    started: { [key: string]: Event } = {};
    finished: Event[] = [];

    startModule(module: Module, compilation: Compilation): void {
        const moduleName = getModuleName(module, compilation, this.cwd);
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

    doneModule(module: Module, compilation: Compilation): void {
        const moduleName = getModuleName(module, compilation, this.cwd);
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
