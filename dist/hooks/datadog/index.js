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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const chalk_1 = __importDefault(require("chalk"));
const aggregator_1 = require("./aggregator");
const helpers_1 = require("./helpers");
const sender_1 = require("./sender");
const getOptionsDD = (opts) => ({
    timestamp: Math.floor((opts.timestamp || Date.now()) / 1000),
    apiKey: opts.apiKey,
    tags: opts.tags || [],
    endPoint: opts.endPoint || 'app.datadoghq.com',
    prefix: opts.prefix || '',
    filters: opts.filters || [],
});
const preoutput = function output({ report, stats }) {
    return __awaiter(this, void 0, void 0, function* () {
        const optionsDD = getOptionsDD(this.options.datadog);
        let metrics = [];
        try {
            metrics = yield aggregator_1.getMetrics(report, stats, Object.assign(Object.assign({}, optionsDD), { context: this.options.context }));
        }
        catch (e) {
            this.log(`Couldn't aggregate metrics. ${e.toString()}`, 'error');
        }
        return { metrics };
    });
};
const postoutput = function postoutput({ start, metrics }) {
    return __awaiter(this, void 0, void 0, function* () {
        const PLUGIN_NAME = this.constructor.name;
        const duration = Date.now() - start;
        const optionsDD = getOptionsDD(this.options.datadog);
        // We're missing the duration of this hook for our plugin.
        metrics.push(helpers_1.getMetric({
            tags: [`pluginName:${PLUGIN_NAME}`],
            metric: `plugins.meta.duration`,
            type: 'duration',
            value: duration,
        }, optionsDD));
        this.log(`Took ${duration}ms.`);
        // Send everything only if we have the key.
        if (!optionsDD.apiKey) {
            this.log(`Won't send metrics to ${chalk_1.default.bold('Datadog')}: missing API Key.`, 'warn');
            return;
        }
        try {
            yield sender_1.sendMetrics(metrics, {
                apiKey: optionsDD.apiKey,
                endPoint: optionsDD.endPoint,
            });
        }
        catch (e) {
            this.log(`Error sending metrics ${e.toString()}`, 'error');
        }
        return { metrics };
    });
};
module.exports = {
    hooks: {
        preoutput,
        postoutput,
    },
};
