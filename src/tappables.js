// Unless explicitly stated otherwise all files in this repository are licensed
// under the Apache License Version 2.0.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

const { performance } = require('perf_hooks');

const { getPluginName } = require('./helpers');

class TappablesPlugin {
    monitoredTaps = {};
    tappables = [];
    hooks = {};
    timings = {};
    getContext(args) {
        return args.map(arg => ({
            type: arg.constructor.name,
            name: arg.name,
            value: typeof arg === 'string' ? arg : undefined
        }));
    }

    saveResult(type, pluginName, hookName, context, start, end) {
        if (!this.timings[pluginName]) {
            this.timings[pluginName] = { name: pluginName, hooks: {} };
        }
        if (!this.timings[pluginName].hooks[hookName]) {
            this.timings[pluginName].hooks[hookName] = {
                name: hookName,
                values: []
            };
        }

        this.timings[pluginName].hooks[hookName].values.push({
            start,
            end,
            duration: end - start,
            context,
            type
        });
    }

    getResults() {
        const timings = this.timings;

        // Aggregate the durations for each plugin.
        for (const [tappableName, tappable] of Object.entries(this.timings)) {
            const timing = tappable;
            timing.duration = Object.values(tappable.hooks)
                .map(hookArray =>
                    hookArray.values.reduce((previous, current) => {
                        return previous + current.end - current.start;
                    }, 0)
                )
                .reduce((previous, current) => previous + current, 0);
            timings[tappableName] = timing;
        }

        return {
            monitoredTaps: this.monitoredTaps,
            tappables: this.tappables,
            hooks: this.hooks,
            timings
        };
    }

    getPromiseTapPatch(type, fn, pluginName, hookName) {
        return (...args) => {
            // Find new hooks
            this.checkHooks();
            const startTime = performance.now();
            const returnValue = fn.apply(this, args);
            const cb = () => {
                this.saveResult(
                    type,
                    pluginName,
                    hookName,
                    this.getContext(args),
                    startTime,
                    performance.now()
                );
            };
            // Save the result whether it succeeds or not.
            returnValue.then(cb, cb);
            return returnValue;
        };
    }

    getAsyncTapPatch(type, fn, pluginName, hookName) {
        return (...args) => {
            // Find new hooks
            this.checkHooks();
            const startTime = performance.now();
            // Callback is the last argument.
            const originalCB = args.pop();
            const newCB = (...a) => {
                this.saveResult(
                    type,
                    pluginName,
                    hookName,
                    this.getContext(args),
                    startTime,
                    performance.now()
                );
                return originalCB(...a);
            };
            return fn.apply(this, [...args, newCB]);
        };
    }

    getDefaultTapPatch(type, fn, pluginName, hookName) {
        return (...args) => {
            // Find new hooks
            this.checkHooks();
            const startTime = performance.now();
            const returnValue = fn.apply(this, args);
            this.saveResult(
                type,
                pluginName,
                hookName,
                this.getContext(args),
                startTime,
                performance.now()
            );
            return returnValue;
        };
    }

    // Patch the tap so we can report its execution duration.
    getTapPatch(type, fn, pluginName, hookName) {
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

    newTap(type, hookName, originalTap, scope) {
        return (options, fn) => {
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

    replaceTaps(hookName, hook) {
        // Cover three types of tap.
        hook.tap = this.newTap('default', hookName, hook.tap, hook);
        hook.tapAsync = this.newTap('async', hookName, hook.tapAsync, hook);
        hook.tapPromise = this.newTap(
            'promise',
            hookName,
            hook.tapPromise,
            hook
        );
    }

    checkHooks() {
        // We reparse hooks in case new ones arrived.
        for (const tappable of this.tappables) {
            const name = tappable.constructor.name;
            for (const hookName of Object.keys(tappable.hooks)) {
                if (!this.hooks[name].includes(hookName)) {
                    this.hooks[name].push(hookName);
                    this.replaceTaps(hookName, tappable.hooks[hookName]);
                }
            }
        }
    }

    // Let's navigate through all the hooks we can find.
    throughHooks(tappable) {
        const name = tappable.constructor.name;
        if (!this.tappables.includes(tappable)) {
            this.tappables.push(tappable);
        }
        if (!this.hooks[name]) {
            this.hooks[name] = [];
        }
        for (const hookName of Object.keys(tappable.hooks)) {
            this.hooks[name].push(hookName);
            this.replaceTaps(hookName, tappable.hooks[hookName]);
        }
    }
}

module.exports = TappablesPlugin;
