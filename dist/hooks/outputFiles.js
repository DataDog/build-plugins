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
const path_1 = __importDefault(require("path"));
const helpers_1 = require("../helpers");
const output = function output({ report, metrics, bundler }) {
    return __awaiter(this, void 0, void 0, function* () {
        const opts = this.options.output;
        if (typeof opts === 'string' || typeof opts === 'object') {
            const startWriting = Date.now();
            let destination;
            const files = {
                timings: true,
                dependencies: true,
                bundler: true,
                metrics: true,
                result: true,
            };
            if (typeof opts === 'object') {
                destination = opts.destination;
                files.timings = opts.timings || false;
                files.dependencies = opts.dependencies || false;
                files.bundler = opts.bundler || false;
                files.metrics = opts.metrics || false;
            }
            else {
                destination = opts;
            }
            const outputPath = path_1.default.resolve(this.options.context, destination);
            try {
                const errors = {};
                const filesToWrite = {};
                if (files.timings && (report === null || report === void 0 ? void 0 : report.timings)) {
                    filesToWrite.timings = {
                        content: {
                            tapables: report.timings.tapables
                                ? Array.from(report.timings.tapables.values())
                                : null,
                            loaders: report.timings.loaders
                                ? Array.from(report.timings.loaders.values())
                                : null,
                            modules: report.timings.modules
                                ? Array.from(report.timings.modules.values())
                                : null,
                        },
                    };
                }
                if (files.dependencies && (report === null || report === void 0 ? void 0 : report.dependencies)) {
                    filesToWrite.dependencies = { content: report.dependencies };
                }
                if (files.bundler) {
                    if (bundler.webpack) {
                        filesToWrite.bundler = { content: bundler.webpack.toJson({ children: false }) };
                    }
                    if (bundler.esbuild) {
                        filesToWrite.bundler = { content: bundler.esbuild };
                    }
                }
                if (metrics && files.metrics) {
                    filesToWrite.metrics = { content: metrics };
                }
                const proms = Object.keys(filesToWrite).map((file) => {
                    const start = Date.now();
                    this.log(`Start writing ${file}.json.`);
                    return helpers_1.writeFile(path_1.default.join(outputPath, `${file}.json`), filesToWrite[file].content)
                        .then(() => {
                        this.log(`Wrote ${file}.json in ${helpers_1.formatDuration(Date.now() - start)}`);
                    })
                        .catch((e) => {
                        this.log(`Failed to write ${file}.json in ${helpers_1.formatDuration(Date.now() - start)}`, 'error');
                        errors[file] = e;
                    });
                });
                // We can't use Promise.allSettled because we want to support NodeJS 10+
                yield Promise.all(proms);
                this.log(`Wrote files in ${helpers_1.formatDuration(Date.now() - startWriting)}.`);
                // If we had some errors.
                const fileErrored = Object.keys(errors);
                if (fileErrored.length) {
                    this.log(`Couldn't write files.\n${fileErrored.map((file) => `  - ${file}: ${errors[file].toString()}`)}`, 'error');
                }
            }
            catch (e) {
                this.log(`Couldn't write files. ${e.toString()}`, 'error');
            }
        }
    });
};
exports.hooks = { output };
