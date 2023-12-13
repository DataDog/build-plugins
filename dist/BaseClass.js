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
const chalk_1 = __importDefault(require("chalk"));
class BaseClass {
    constructor(options = {}) {
        this.name = 'BuildPlugin';
        this.hooks = [
            // eslint-disable-next-line global-require
            require('./hooks/renderer'),
            // eslint-disable-next-line global-require
            require('./hooks/datadog'),
            // eslint-disable-next-line global-require
            require('./hooks/outputFiles'),
        ];
        // Add custom hooks
        if (options.hooks && options.hooks.length) {
            try {
                this.hooks.push(...options.hooks
                    .map((hookPathInput) => require.resolve(hookPathInput, {
                    paths: [process.cwd()],
                }))
                    // eslint-disable-next-line global-require,import/no-dynamic-require
                    .map((hookPath) => require(hookPath)));
            }
            catch (e) {
                this.log(`Couldn't add custom hook.`, 'error');
                this.log(e);
            }
        }
        this.hooksContext = {};
        this.options = {
            disabled: options.disabled,
            output: options.output,
            datadog: options.datadog,
            context: options.context,
        };
    }
    log(text, type = 'log') {
        const PLUGIN_NAME = this.name;
        let color = chalk_1.default;
        if (type === 'error') {
            color = chalk_1.default.red;
        }
        else if (type === 'warn') {
            color = chalk_1.default.yellow;
        }
        console[type](`[${chalk_1.default.bold(PLUGIN_NAME)}] ${color(text)}`);
    }
    addContext(context) {
        this.hooksContext = Object.assign(Object.assign({}, this.hooksContext), context);
    }
    // Will apply hooks for prehookName, hookName and posthookName
    applyHooks(hookName) {
        return __awaiter(this, void 0, void 0, function* () {
            const applyHook = (name) => {
                const proms = [];
                for (const hook of this.hooks) {
                    if (hook.hooks && typeof hook.hooks[name] === 'function') {
                        const hookCall = hook.hooks[name].call(this, this.hooksContext);
                        if (hookCall && typeof hookCall.then === 'function') {
                            proms.push(hookCall.then(this.addContext.bind(this)));
                        }
                        else if (hookCall) {
                            this.addContext(hookCall);
                        }
                    }
                }
                return Promise.all(proms);
            };
            yield applyHook(`pre${hookName}`);
            yield applyHook(hookName);
            yield applyHook(`post${hookName}`);
        });
    }
}
exports.BaseClass = BaseClass;
