// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { performance } from 'perf_hooks';
// In order to not overlap with our own Compilation type.
// TODO use native webpack types now that we need to import it.
import webpack from 'webpack';

import { getPluginName, getValueContext } from '../common/helpers';
import type {
    MonitoredTaps,
    Tapable,
    Hooks,
    TimingsMap,
    ValueContext,
    TAP_TYPES,
    TapablesResult,
    TapPromise,
    TapAsync,
    Tap,
    Hook,
    Timing,
    TelemetryOptions,
} from '../types';

export class Tapables {
    constructor(cwd: string, options: TelemetryOptions) {
        this.options = options;
        this.cwd = cwd;
    }
    cwd: string;
    options: TelemetryOptions;
    monitoredTaps: MonitoredTaps = {};
    tapables: Tapable[] = [];
    hooks: Hooks = {};
    timings: TimingsMap = new Map();

    saveResult(
        type: TAP_TYPES,
        pluginName: string,
        hookName: string,
        context: ValueContext[],
        start: number,
        end: number,
    ) {
        const timing: Timing = this.timings.get(pluginName) || {
            name: pluginName,
            duration: 0,
            increment: 0,
            events: {},
        };
        if (!timing.events[hookName]) {
            timing.events[hookName] = {
                name: hookName,
                values: [],
            };
        }

        timing.events[hookName].values.push({
            start,
            end,
            duration: end - start,
            context,
            type,
        });
        timing.duration += end - start;
        timing.increment += 1;
        this.timings.set(pluginName, timing);
    }

    getResults(): TapablesResult {
        const timings = this.timings;

        // Aggregate the durations for each plugin.
        for (const [tapableName, tapable] of this.timings) {
            const timing = tapable;
            timing.duration = Object.values(tapable.events)
                .map((hookArray) =>
                    hookArray.values.reduce((previous, current) => {
                        return previous + current.end - current.start;
                    }, 0),
                )
                .reduce((previous, current) => previous + current, 0);
            timings.set(tapableName, timing);
        }

        return {
            monitoredTaps: this.monitoredTaps,
            tapables: this.tapables,
            hooks: this.hooks,
            timings,
        };
    }

    getPromiseTapPatch(type: TAP_TYPES, fn: TapPromise, pluginName: string, hookName: string) {
        return (...args: [any]) => {
            // Find new hooks
            this.checkHooks();
            const startTime = performance.now();
            const returnValue = fn.apply(this, args);
            const cb = () => {
                this.saveResult(
                    type,
                    pluginName,
                    hookName,
                    getValueContext(args),
                    startTime,
                    performance.now(),
                );
            };
            // Save the result whether it succeeds or not.
            returnValue.then(cb, cb);
            return returnValue;
        };
    }

    getAsyncTapPatch(type: TAP_TYPES, fn: TapAsync, pluginName: string, hookName: string) {
        return (...args: [any]) => {
            // Find new hooks
            this.checkHooks();
            const startTime = performance.now();
            // Callback is the last argument.
            const originalCB = args.pop();
            const newCB = (...a: [any]) => {
                this.saveResult(
                    type,
                    pluginName,
                    hookName,
                    getValueContext(args),
                    startTime,
                    performance.now(),
                );
                return originalCB(...a);
            };
            return fn.apply(this, [...args, newCB]);
        };
    }

    getDefaultTapPatch(type: TAP_TYPES, fn: Tap, pluginName: string, hookName: string) {
        return (...args: [any]) => {
            // Find new hooks
            this.checkHooks();
            const startTime = performance.now();
            const returnValue = fn.apply(this, args);
            this.saveResult(
                type,
                pluginName,
                hookName,
                getValueContext(args),
                startTime,
                performance.now(),
            );
            return returnValue;
        };
    }

    // Patch the tap so we can report its execution duration.
    getTapPatch(type: TAP_TYPES, fn: (args: any) => any, pluginName: string, hookName: string) {
        switch (type) {
            case 'promise':
                return this.getPromiseTapPatch(type, fn, pluginName, hookName);
            case 'async':
                return this.getAsyncTapPatch(type, fn, pluginName, hookName);
            case 'default':
            default:
                return this.getDefaultTapPatch(type, fn, pluginName, hookName);
        }
    }

    newTap(
        type: TAP_TYPES,
        hookName: string,
        originalTap: Tap | TapAsync | TapPromise,
        scope: any,
    ) {
        return (options: any, fn: (args: any) => any) => {
            const pluginName = getPluginName(options);
            const key = `${hookName}-${pluginName}`;
            if (this.monitoredTaps[key]) {
                // Since it's monitored, fn is already patched.
                return originalTap.call(scope, options, fn);
            }
            this.monitoredTaps[key] = true;
            const newFn = this.getTapPatch(type, fn, pluginName, hookName);
            return originalTap.call(scope, options, newFn);
        };
    }

    replaceTaps(hookName: string, hook: Hook) {
        // Cover three types of tap.
        hook.tap = this.newTap('default', hookName, hook.tap!, hook);
        hook.tapAsync = this.newTap('async', hookName, hook.tapAsync!, hook);
        hook.tapPromise = this.newTap('promise', hookName, hook.tapPromise!, hook);
    }

    checkHooks() {
        // We reparse hooks in case new ones arrived.
        for (const tapable of this.tapables) {
            const name = tapable.constructor.name;
            for (const hookName of Object.keys(tapable.hooks)) {
                if (!this.hooks[name].includes(hookName)) {
                    this.hooks[name].push(hookName);
                    this.replaceTaps(hookName, tapable.hooks[hookName]);
                }
            }
        }
    }

    // Let's navigate through all the hooks we can find.
    throughHooks(tapable: Tapable) {
        const name = tapable.constructor.name;
        if (!this.tapables.includes(tapable)) {
            this.tapables.push(tapable);
        }
        if (!this.hooks[name]) {
            this.hooks[name] = [];
        }
        for (const hookName of Object.keys(tapable.hooks)) {
            this.hooks[name].push(hookName);
            try {
                // Webpack 5 deprecation fix for DEP_WEBPACK_COMPILATION_NORMAL_MODULE_LOADER_HOOK.
                if (
                    hookName === 'normalModuleLoader' &&
                    typeof webpack.NormalModule.getCompilationHooks === 'function'
                ) {
                    const NormalModule = webpack.NormalModule;
                    // Needed to use it "as webpack.Compilation"
                    const compil = tapable as unknown;
                    this.replaceTaps(
                        hookName,
                        NormalModule.getCompilationHooks(compil as webpack.Compilation).loader,
                    );
                } else {
                    this.replaceTaps(hookName, tapable.hooks[hookName]);
                }
            } catch (e) {
                // In Webpack 5 hooks are frequently read-only objects.
                // TODO Find a way to replace them.
            }
        }
    }
}
