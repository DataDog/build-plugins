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
const chalk_1 = __importDefault(require("chalk"));
const aggregator_1 = require("./aggregator");
const helpers_1 = require("./helpers");
const sender_1 = require("./sender");
const helpers_2 = require("../../helpers");
const getOptionsDD = (opts = {}) => ({
    timestamp: Math.floor((opts.timestamp || Date.now()) / 1000),
    apiKey: opts.apiKey || '',
    tags: opts.tags || [],
    endPoint: opts.endPoint || 'app.datadoghq.com',
    prefix: opts.prefix || '',
    filters: opts.filters || helpers_1.defaultFilters,
});
const preoutput = function output({ report, bundler }) {
    return __awaiter(this, void 0, void 0, function* () {
        const optionsDD = getOptionsDD(this.options.datadog);
        let metrics = [];
        try {
            metrics = aggregator_1.getMetrics(Object.assign(Object.assign({}, optionsDD), { context: this.options.context }), report, bundler);
        }
        catch (e) {
            this.log(`Couldn't aggregate metrics: ${e.stack}`, 'error');
        }
        return { metrics };
    });
};
const postoutput = function postoutput({ start, metrics }) {
    return __awaiter(this, void 0, void 0, function* () {
        const PLUGIN_NAME = this.name;
        const duration = Date.now() - start;
        const optionsDD = getOptionsDD(this.options.datadog);
        // We're missing the duration of this hook for our plugin.
        metrics.push(helpers_1.getMetric({
            tags: [`pluginName:${PLUGIN_NAME}`],
            metric: `plugins.meta.duration`,
            type: 'duration',
            value: duration,
        }, optionsDD));
        this.log(`Took ${helpers_2.formatDuration(duration)}.`);
        // Send everything only if we have the key.
        if (!optionsDD.apiKey) {
            this.log(`Won't send metrics to ${chalk_1.default.bold('Datadog')}: missing API Key.`, 'warn');
            return;
        }
        try {
            const startSending = Date.now();
            yield sender_1.sendMetrics(metrics, {
                apiKey: optionsDD.apiKey,
                endPoint: optionsDD.endPoint,
            });
            this.log(`Sent metrics in ${helpers_2.formatDuration(Date.now() - startSending)}.`);
        }
        catch (e) {
            this.log(`Error sending metrics ${e.toString()}`, 'error');
        }
        return { metrics };
    });
};
exports.hooks = {
    preoutput,
    postoutput,
};
