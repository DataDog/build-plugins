"use strict";
// Unless explicitly stated otherwise all files in this repository are licensed
// under the MIT License.
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
const path = require('path');
const { outputJson } = require('fs-extra');
const output = function output({ report, metrics, stats }) {
    return __awaiter(this, void 0, void 0, function* () {
        if (typeof this.options.output === 'string') {
            const startWriting = Date.now();
            const outputPath = path.join(this.options.context, this.options.output);
            try {
                const spaces = '  ';
                yield Promise.all([
                    outputJson(path.join(outputPath, 'timings.json'), {
                        tappables: report.timings.tappables,
                        loaders: report.timings.loaders,
                        modules: report.timings.modules,
                    }, { spaces }),
                    outputJson(path.join(outputPath, 'dependencies.json'), report.dependencies, {
                        spaces,
                    }),
                    outputJson(path.join(outputPath, 'stats.json'), stats.toJson({ children: false }), {
                        spaces,
                    }),
                    metrics &&
                        outputJson(path.join(outputPath, 'metrics.json'), metrics, {
                            spaces,
                        }),
                ]);
                this.log(`Wrote files in ${Date.now() - startWriting}ms.`);
            }
            catch (e) {
                this.log(`Couldn't write files. ${e.toString()}`, 'error');
            }
        }
    });
};
module.exports = { hooks: { output } };
