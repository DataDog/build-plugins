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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable no-console */
const BaseClass_1 = require("../BaseClass");
const loaders_1 = require("./loaders");
const modules_1 = require("./modules");
const tapables_1 = require("./tapables");
const dd_trace_1 = __importDefault(require("dd-trace"));
class BuildPlugin extends BaseClass_1.BaseClass {
    apply(compiler) {
        if (this.options.disabled) {
            return;
        }
        const mainSpan = dd_trace_1.default.startSpan('BuildPlugin');
        const scope = dd_trace_1.default.scope();
        scope.activate(mainSpan, () => {
            const PLUGIN_NAME = this.name;
            const HOOK_OPTIONS = { name: PLUGIN_NAME };
            const modules = new modules_1.Modules(this.options);
            const tapables = new tapables_1.Tapables(this.options);
            const loaders = new loaders_1.Loaders(this.options);
            tapables.throughHooks(compiler);
            compiler.hooks.thisCompilation.tap(HOOK_OPTIONS, (compilation) => {
                this.options.context = this.options.context || compilation.options.context;
                tapables.throughHooks(compilation);
                compilation.hooks.buildModule.tap(HOOK_OPTIONS, (module) => {
                    loaders.buildModule(module, compilation);
                });
                compilation.hooks.succeedModule.tap(HOOK_OPTIONS, (module) => {
                    loaders.succeedModule(module, compilation);
                });
                compilation.hooks.afterOptimizeTree.tap(HOOK_OPTIONS, (chunks, mods) => {
                    modules.afterOptimizeTree(chunks, mods, compilation);
                });
            });
            compiler.hooks.done.tapPromise(HOOK_OPTIONS, (stats) => __awaiter(this, void 0, void 0, function* () {
                const start = Date.now();
                const { timings: tapableTimings } = tapables.getResults();
                const { loaders: loadersTimings, modules: modulesTimings } = loaders.getResults();
                const { modules: modulesDeps } = modules.getResults();
                const report = {
                    timings: {
                        tapables: tapableTimings,
                        loaders: loadersTimings,
                        modules: modulesTimings,
                    },
                    dependencies: modulesDeps,
                };
                this.addContext({
                    start,
                    report,
                    bundler: { webpack: stats },
                });
                yield this.applyHooks('output');
                this.log('Work done.');
                mainSpan.finish();
            }));
        });
    }
}
exports.BuildPlugin = BuildPlugin;
