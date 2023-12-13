"use strict";
// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
const helpers_1 = require("../helpers");
exports.getGeneralReport = (report, bundler) => {
    if (bundler.webpack) {
        const stats = bundler.webpack.toJson({ children: false });
        return {
            modules: stats.modules.length,
            chunks: stats.chunks.length,
            assets: stats.assets.length,
            warnings: stats.warnings.length,
            errors: stats.errors.length,
            entries: Object.keys(stats.entrypoints).length,
            duration: stats.time,
        };
    }
    else if (bundler.esbuild) {
        const stats = bundler.esbuild;
        return {
            modules: report.dependencies ? Object.keys(report.dependencies).length : 0,
            chunks: undefined,
            assets: stats.outputs ? Object.keys(stats.outputs).length : 0,
            warnings: stats.warnings.length,
            errors: stats.errors.length,
            entries: stats.entrypoints ? Object.keys(stats.entrypoints).length : undefined,
            duration: stats.duration,
        };
    }
    return {};
};
exports.getGenerals = (report) => {
    const { duration } = report, extracted = __rest(report, ["duration"]);
    const metrics = [];
    for (const [key, value] of Object.entries(extracted)) {
        metrics.push({
            metric: `${key}.count`,
            type: 'count',
            value,
            tags: [],
        });
    }
    if (report.duration) {
        metrics.push({
            metric: 'compilation.duration',
            type: 'duration',
            value: report.duration,
            tags: [],
        });
    }
    return metrics;
};
exports.getDependencies = (modules) => helpers_1.flattened(modules.map((m) => [
    {
        metric: 'modules.dependencies',
        type: 'count',
        value: m.dependencies.length,
        tags: [`moduleName:${m.name}`, `moduleType:${helpers_1.getType(m.name)}`],
    },
    {
        metric: 'modules.dependents',
        type: 'count',
        value: m.dependents.length,
        tags: [`moduleName:${m.name}`, `moduleType:${helpers_1.getType(m.name)}`],
    },
]));
exports.getPlugins = (plugins) => {
    const metrics = [];
    metrics.push({
        metric: 'plugins.count',
        type: 'count',
        value: plugins.size,
        tags: [],
    });
    for (const plugin of plugins.values()) {
        let pluginDuration = 0;
        let pluginCount = 0;
        for (const hook of Object.values(plugin.events)) {
            let hookDuration = 0;
            pluginCount += hook.values.length;
            for (const v of hook.values) {
                const duration = v.end - v.start;
                hookDuration += duration;
                pluginDuration += duration;
            }
            metrics.push({
                metric: 'plugins.hooks.duration',
                type: 'duration',
                value: hookDuration,
                tags: [`pluginName:${plugin.name}`, `hookName:${hook.name}`],
            }, {
                metric: 'plugins.hooks.increment',
                type: 'count',
                value: hook.values.length,
                tags: [`pluginName:${plugin.name}`, `hookName:${hook.name}`],
            });
        }
        metrics.push({
            metric: 'plugins.duration',
            type: 'duration',
            value: pluginDuration,
            tags: [`pluginName:${plugin.name}`],
        }, {
            metric: 'plugins.increment',
            type: 'count',
            value: pluginCount,
            tags: [`pluginName:${plugin.name}`],
        });
    }
    return metrics;
};
exports.getLoaders = (loaders) => {
    const metrics = [];
    metrics.push({
        metric: 'loaders.count',
        type: 'count',
        value: loaders.size,
        tags: [],
    });
    for (const loader of loaders.values()) {
        metrics.push({
            metric: 'loaders.duration',
            type: 'duration',
            value: loader.duration,
            tags: [`loaderName:${loader.name}`],
        }, {
            metric: 'loaders.increment',
            type: 'count',
            value: loader.increment,
            tags: [`loaderName:${loader.name}`],
        });
    }
    return metrics;
};
