"use strict";
// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const perf_hooks_1 = require("perf_hooks");
const helpers_1 = require("../helpers");
var FN_TO_WRAP;
(function (FN_TO_WRAP) {
    FN_TO_WRAP["START"] = "onStart";
    FN_TO_WRAP["LOAD"] = "onLoad";
    FN_TO_WRAP["RESOLVE"] = "onResolve";
    FN_TO_WRAP["END"] = "onEnd";
})(FN_TO_WRAP || (FN_TO_WRAP = {}));
const pluginsMap = new Map();
const modulesMap = new Map();
exports.wrapPlugins = (build, context) => {
    const plugins = build.initialOptions.plugins;
    if (plugins) {
        // We clone plugins so we don't pass modified options to other plugins.
        const initialPlugins = plugins.map((plugin) => {
            return Object.assign({}, plugin);
        });
        for (const plugin of plugins) {
            const newBuildObject = getNewBuildObject(build, plugin.name, context);
            const oldSetup = plugin.setup;
            plugin.setup = () => {
                oldSetup(Object.assign(Object.assign({}, newBuildObject), { 
                    // Use non-modified plugins for other plugins
                    initialOptions: Object.assign(Object.assign({}, newBuildObject.initialOptions), { plugins: initialPlugins }) }));
            };
        }
    }
};
const getNewBuildObject = (build, pluginName, context) => {
    const newBuildObject = Object.assign({}, build);
    for (const fn of Object.values(FN_TO_WRAP)) {
        newBuildObject[fn] = (opts, cb) => __awaiter(void 0, void 0, void 0, function* () {
            const pluginTiming = pluginsMap.get(pluginName) || {
                name: pluginName,
                increment: 0,
                duration: 0,
                events: {},
            };
            pluginTiming.events[fn] = pluginTiming.events[fn] || {
                name: fn,
                values: [],
            };
            return build[fn](opts, (...args) => __awaiter(void 0, void 0, void 0, function* () {
                const modulePath = helpers_1.formatModuleName(args[0].path, context);
                const moduleTiming = modulesMap.get(modulePath) || {
                    name: modulePath,
                    increment: 0,
                    duration: 0,
                    events: {},
                };
                moduleTiming.events[fn] = moduleTiming.events[fn] || {
                    name: fn,
                    values: [],
                };
                const start = perf_hooks_1.performance.now();
                try {
                    return yield cb(...args);
                }
                finally {
                    const end = perf_hooks_1.performance.now();
                    const duration = end - start;
                    const statsObject = {
                        start,
                        end,
                        duration,
                        context: helpers_1.getContext(args),
                    };
                    pluginTiming.events[fn].values.push(statsObject);
                    pluginTiming.duration += duration;
                    pluginTiming.increment += 1;
                    pluginsMap.set(pluginName, pluginTiming);
                    moduleTiming.events[fn].values.push(statsObject);
                    moduleTiming.duration += duration;
                    moduleTiming.increment += 1;
                    modulesMap.set(modulePath, moduleTiming);
                }
            }));
        });
    }
    return newBuildObject;
};
exports.getResults = () => ({ plugins: pluginsMap, modules: modulesMap });
