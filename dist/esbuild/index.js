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
const plugins_1 = require("./plugins");
const BaseClass_1 = require("../BaseClass");
const modules_1 = require("./modules");
class BuildPluginClass extends BaseClass_1.BaseClass {
    constructor(opts) {
        super(opts);
        this.options.context = opts.context || process.cwd();
    }
    setup(build) {
        if (this.options.disabled) {
            return;
        }
        const startBuild = Date.now();
        // We force esbuild to produce its metafile.
        build.initialOptions.metafile = true;
        plugins_1.wrapPlugins(build, this.options.context || process.cwd());
        build.onEnd((result) => __awaiter(this, void 0, void 0, function* () {
            const { plugins, modules } = plugins_1.getResults();
            // We know it exists since we're setting the option earlier.
            const metaFile = result.metafile;
            const moduleResults = modules_1.getModulesResults(this.options, metaFile);
            this.addContext({
                start: startBuild,
                report: {
                    timings: {
                        tapables: plugins,
                        modules,
                    },
                    dependencies: moduleResults,
                },
                bundler: {
                    esbuild: Object.assign({ warnings: result.warnings, errors: result.errors, entrypoints: build.initialOptions.entryPoints, duration: Date.now() - startBuild }, metaFile),
                },
            });
            yield this.applyHooks('output');
            this.log('Work done.');
        }));
    }
}
exports.BuildPluginClass = BuildPluginClass;
exports.BuildPlugin = (opts = {}) => {
    const plugin = new BuildPluginClass(opts);
    // Esbuild validates the properties of the plugin so we only return a subset.
    return {
        name: plugin.name,
        setup: plugin.setup.bind(plugin),
    };
};
