// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

import { getPluginName, getValueContext } from '@dd/telemetry-plugin/common/helpers';
import { PLUGIN_NAME } from '@dd/telemetry-plugin/constants';
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
} from '@dd/telemetry-plugin/types';
import { performance } from 'perf_hooks';

export class Tapables {
    constructor(cwd: Tapables['cwd']) {
        this.cwd = cwd;
    }
    cwd: string;
    monitoredTaps: MonitoredTaps = {};
    tapables: Tapable[] = [];
    hooks: Hooks = {};
    timings: TimingsMap = new Map();
    ignoredHooks = [
        // This one triggers a DEP_WEBPACK_COMPILATION_NORMAL_MODULE_LOADER_HOOK warning.
        'normalModuleLoader',
    ];

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
            this.checkNewHooks();
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
            this.checkNewHooks();
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
            this.checkNewHooks();
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

    patchHook(tapableName: string, hookName: string, hook: Hook) {
        // Webpack 5 specific, these _fakeHook are not writable.
        // eslint-disable-next-line no-underscore-dangle
        if (hook._fakeHook) {
            return;
        }

        // Skip the current plugin.
        if (tapableName.includes(PLUGIN_NAME)) {
            return;
        }

        if (!this.hooks[tapableName]) {
            this.hooks[tapableName] = [];
        }

        if (this.hooks[tapableName].includes(hookName)) {
            return;
        }

        this.hooks[tapableName].push(hookName);
        this.replaceTaps(hookName, hook);
    }

    patchHooks(tapable: Tapable) {
        const name = tapable.constructor.name;
        const hooksToPatch = Object.keys(tapable.hooks).filter((hookName) => {
            // Skip the ignored hooks.
            if (this.ignoredHooks.includes(hookName)) {
                return false;
            }

            // Skip the already patched hooks.
            if (this.hooks[name]?.includes(hookName)) {
                return false;
            }

            return true;
        });

        for (const hookName of hooksToPatch) {
            this.patchHook(name, hookName, tapable.hooks[hookName]);
        }
    }

    checkNewHooks() {
        // We reparse hooks in case new ones arrived.
        for (const tapable of this.tapables) {
            this.patchHooks(tapable);
        }
    }

    // Let's navigate through all the hooks we can find.
    throughHooks(tapable: Tapable) {
        if (!this.tapables.includes(tapable)) {
            this.tapables.push(tapable);
        }

        this.patchHooks(tapable);
    }
}
